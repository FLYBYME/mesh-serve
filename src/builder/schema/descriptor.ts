/**
 * `mesh.json` in a **part** repository — build input.
 *
 * There are two files called `mesh.json` in this system and they are not the same thing. This is the
 * one a repository commits:
 *
 * | | says | written by |
 * | --- | --- | --- |
 * | this file | *I build these parts, and they call these contracts* | the part's author — a **requirement** |
 * | the site record | *I expose these contracts, at this gate* | the site's owner — a **grant** |
 *
 * A part must never choose its own gate. If a repository could declare `domains.zone_delete` public,
 * then installing a part would be a privilege escalation with nobody in the loop. So `contracts` here
 * is a list of bare keys, and there is nowhere to put an `auth`.
 *
 * Two things are deliberately absent, and both are the same rule — **a repository does not get to
 * describe the world outside itself**:
 *
 * - **The tenant.** A repository that could name its own owner could name someone else's. Ownership
 *   comes from whoever asked for the build, whose scope the API already resolved.
 * - **A host, an api, an environment.** A site is a hostname and a record. One artifact serves every
 *   site that chooses it, which is the whole reason a part can be versioned at all.
 *
 * And one thing that used to be here is gone: **there is no build command.** The repository names an
 * entry; the builder runs esbuild. See `spec/building.md` §3.
 */

import { z } from '@flybyme/mesh';

/** What the file is called in a repository. */
export const DESCRIPTOR_FILE = 'mesh.json';

/**
 * A path inside the repository, and only inside it.
 *
 * The builder runs untrusted code from a repository, so an entry that escapes the workspace is the
 * whole threat model in one field.
 */
const innerPath = z.string().min(1)
    .refine((p) => !p.startsWith('/'), { message: 'must be relative to the repository root' })
    .refine((p) => !p.split('/').includes('..'), { message: 'must not leave the repository' });

/**
 * A package this part calls into, and which of its contracts.
 *
 * Grouped by package because the grouping does two jobs: it is the dependency — which package, at
 * which version — and it is where a generator looks to resolve those keys to schemas. It is also
 * what makes a string checkable: the build asks the catalog whether that package really exports
 * those contracts, which is what recovers the compile error lost by naming a contract instead of
 * importing it.
 */
export const RequiredPackageSchema = z.object({
    package: z.string().min(1),
    version: z.string().min(1),
    /**
     * `domain.action`, e.g. `domains.zone_find`. Keys only.
     *
     * Non-empty: a package named with nothing taken from it is a dependency that does nothing, which
     * is more likely a half-finished edit than an intention.
     */
    contracts: z.array(z.string().min(1)).min(1),
});
export type RequiredPackage = z.infer<typeof RequiredPackageSchema>;

/**
 * One part this repository builds.
 *
 * **`mesh` is per part, not per repository.** A repository-level list would make every part in the
 * repository declare every contract any of them calls, so a site loading only the chrome extension
 * would have to grant it the domain contracts the console app uses. Over-declaring a requirement
 * quietly turns the grant check into a formality, which is the one thing it must not become.
 */
export const DescribedPartSchema = z.object({
    kind: z.enum(['kernel', 'application', 'extension']),
    /** A site's composition names this. Stable across builds. */
    id: z.string().min(1),
    /** What this build publishes as. The catalog resolves a site's range against it. */
    version: z.string().min(1),
    /** The **source** entry — `src/app.ts`. esbuild reads types; it does not check them. */
    entry: innerPath,
    mesh: z.array(RequiredPackageSchema).default([]),
});
export type DescribedPart = z.infer<typeof DescribedPartSchema>;

export const DescriptorSchema = z.object({
    /**
     * Which kernel these parts are built against, as a requirement.
     *
     * Repository-level because it is a property of the tree — one `node_modules`, one set of types —
     * and it is copied into each part's declaration, which is where something eventually compares it.
     *
     * Absent when this repository *is* the kernel, which is the one thing that has no kernel.
     */
    kernel: z.string().min(1).optional(),

    parts: z.array(DescribedPartSchema).min(1)
        .superRefine((parts, ctx) => {
            const seen = new Set<string>();
            parts.forEach((part, index) => {
                // A site names parts by id, so two parts sharing one would make a composition
                // ambiguous about which it loaded — and both artifacts would still build.
                if (seen.has(part.id)) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        path: [index, 'id'],
                        message: `"${part.id}" is declared twice`,
                    });
                }
                seen.add(part.id);
            });
        }),
}).strict();
export type Descriptor = z.infer<typeof DescriptorSchema>;

export class DescriptorError extends Error {
    override readonly name = 'DescriptorError';
}

/**
 * Parse a descriptor, and say where it is wrong.
 *
 * Every failure names the field, because this file is written by hand by someone who is not watching
 * the builder's logs. *"Invalid descriptor"* tells them to guess, and guessing at a build server is
 * a twenty-minute round trip each time.
 */
export function parseDescriptor(text: string): Descriptor {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        throw new DescriptorError(
            `${DESCRIPTOR_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    const parsed = DescriptorSchema.safeParse(value);
    if (parsed.success) return parsed.data;

    const where = (path: readonly (string | number)[]): string =>
        path.length === 0 ? DESCRIPTOR_FILE : `${DESCRIPTOR_FILE} ${path.map(String).join('.')}`;

    throw new DescriptorError(
        parsed.error.issues.map((issue) => `${where(issue.path)}: ${issue.message}`).join('\n'),
    );
}

/**
 * Every contract this part calls, flattened — what goes into its `Declaration.requires`.
 *
 * Sorted and de-duplicated, so a declaration is stable across two descriptors that say the same
 * thing in a different order. An artifact's identity should not depend on how someone typed a list.
 */
export const requirementsOf = (part: DescribedPart): readonly string[] =>
    [...new Set(part.mesh.flatMap((dependency) => dependency.contracts))].sort();
