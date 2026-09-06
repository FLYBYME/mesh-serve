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

import { ClientError, z } from '@flybyme/mesh';

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
 * Another part this one needs installed beside it.
 *
 * A **requirement**, resolved by the catalog like any other range, and checked when a site composes:
 * an application that consumes `AUTH` does not work on a page with no auth Extension, and finding
 * that out at compose time is the difference between a refused deploy and a blank screen.
 *
 * It is not a *grant*. Declaring `auth` here says this part will not function without it; it does not
 * install it, does not choose its version for the site, and does not decide what auth may reach.
 * A site's release is still what says which parts are actually loaded.
 */
export const RequiredPartSchema = z.object({
    id: z.string().min(1),
    version: z.string().min(1).describe('A range, or * for any'),
    /**
     * A part that is nice to have rather than necessary.
     *
     * The honest case: a part that lights up an extra view when something else is present but works
     * without it. Composing reports an unmet optional and refuses an unmet required one.
     */
    optional: z.boolean().default(false),
});
export type RequiredPart = z.infer<typeof RequiredPartSchema>;

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

    /**
     * The packages this part was written against, name → range.
     *
     * **Not an instruction to install.** A build fetches a commit and runs esbuild; it has no
     * `node_modules` and never will, because that is what made a build 95 to 125 seconds. These are
     * a declaration of what the *author* typechecked against, mirroring the repository's own
     * `devDependencies`.
     *
     * Which makes the honest question: what reads it? Two candidates, and they want different
     * things — a **build-time check** that the framework range here agrees with `kernel` above, and
     * a **vendoring rule**, since "vendored or external" means anything that is not the framework
     * has to be committed, and a package named here that is neither is a build that will fail on a
     * missing import with no explanation. Neither is implemented. Recorded rather than guessed at.
     */
    dependencies: z.record(z.string(), z.string()).default({}),

    /**
     * Other parts this one needs on the page.
     *
     * Kept as `requiredParts` even though `parts` is free again now the flat form is gone: inside a
     * part, `parts` would read as *the parts of this part*, which is not what it means. It is a
     * requirement on the composition, and the name should say so.
     *
     * A kernel may declare these too. A kernel that ships no chrome and expects one is stating a real
     * requirement, and the alternative is a bare kernel rendering nothing with no explanation.
     */
    requiredParts: z.array(RequiredPartSchema).default([]),

    mesh: z.array(RequiredPackageSchema).default([]),

    /**
     * ## What a person needs to choose this, as opposed to what a build needs to make it
     *
     * Everything above this line is a *build* input: an entry, a version, what it calls. None of it
     * helps anybody decide whether they want the thing. `part.description` existed in the catalog
     * from the beginning and **no field anywhere filled it**, so every part in a live catalog of
     * thirteen has an empty one.
     *
     * All optional, because a part with no description is a part somebody has not written a
     * description for — not an error. A build must never fail over a missing sentence.
     *
     * These are **not** immutable. `catalog.publish` writes them to the `part` row on every publish,
     * so fixing a typo is a publish rather than a version bump. The one exception is `changelog`,
     * which describes this version and is frozen with it.
     */
    description: z.string().optional(),
    homepage: z.string().optional(),
    license: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    /** A path inside this part's own artifact, so it is content-addressed. Never a URL. */
    icon: innerPath.optional(),
    /** What changed in *this* version. Immutable with it. */
    changelog: z.string().optional(),
});
export type DescribedPart = z.infer<typeof DescribedPartSchema>;

/**
 * Which kernel a part is built against, as a requirement.
 *
 * A property of the tree — one `node_modules`, one set of types — and it is copied into each part's
 * declaration, which is where something eventually compares it. Absent when this repository *is* the
 * kernel, which is the one thing that has no kernel.
 */
const KernelRange = z.string().min(1).optional();

/**
 * A repository builds parts. **One shape, always, even for one part.**
 *
 * A flat single-part form was accepted for a day — a part's fields at the root, no array — on the
 * argument that nesting one part inside an array is noise. It is, slightly. The cost was larger:
 * `mesh-auth` was written flat and `surfdns-console` nested, and an author could not learn the format
 * from either one, because neither was the format.
 *
 * Removing it also removed a constraint it had imposed. `parts` was the discriminator between the two
 * shapes, so it could not also be an ordinary field, which is why a part's own dependencies on other
 * parts are called `requiredParts` — a name chosen to dodge a collision that no longer exists.
 */
export const DescriptorSchema = z.object({
    kernel: KernelRange,
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

/**
 * `400`: the repository's own file is wrong, and whoever asked for the build is the one who can fix
 * it. A `code` so a caller can branch on *this is your descriptor* rather than matching on a string.
 */
export class DescriptorError extends ClientError {
    constructor(message: string) {
        super(message, 'descriptor_invalid', 400);
    }
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
