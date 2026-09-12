/**
 * `mesh.json` — what a repository says about itself.
 *
 * **The one file a repository writes for this platform**, read once at import and turned into part
 * rows. Everything else the builder needs it works out for itself.
 *
 * It is parsed **strictly, with unknown keys refused**, and that is the decision rather than the
 * default: a typo in a key that is silently ignored is a part that builds differently from the way
 * its author wrote it down, and nothing says so. The one exception is a key beginning `//`, which is
 * how this repository's own descriptors carry their reasoning.
 */

import { ClientError, z } from '@flybyme/mesh';

import { PartKindSchema } from './catalog.js';

export const DESCRIPTOR_FILE = 'mesh.json';

/** A path inside the repository. Never absolute, never escaping upward. */
const innerPath = z.string().min(1).refine(
    (value) => !value.startsWith('/') && !value.split('/').includes('..'),
    { message: 'A path in a descriptor is relative to the repository root and may not leave it.' },
);

export const DescribedPartSchema = z.object({
    kind: PartKindSchema,
    id: z.string().min(1).describe('The part name, unique within this repository'),
    entry: innerPath,

    /** The specifier other parts import this one as. */
    import: z.string().min(1).optional(),
    /**
     * Other parts this one imports, marked external and resolved by the site's import map.
     *
     * **An object, and the `version` is read and currently ignored.** A range belongs here — a part
     * that works against `^0.1` of another should say so — but nothing resolves ranges yet, so
     * `compose` pins the newest built version and checks only that the part is present. Declaring it
     * now means the descriptors people write today do not have to change when it is honoured.
     *
     * A bare string is accepted as shorthand for `{ id }`, because that is what a descriptor with
     * one dependency and no opinion about versions wants to write.
     */
    requiredParts: z.array(
        z.union([
            z.string().min(1).transform((id) => ({ id, version: '*' })),
            z.object({
                id: z.string().min(1),
                version: z.string().min(1).default('*').describe('A range. Read, not yet resolved'),
            }),
        ]),
    ).default([]),

    description: z.string().default(''),
    license: z.string().optional(),
    homepage: z.string().optional(),
    keywords: z.array(z.string()).default([]),
});

export type DescribedPart = z.infer<typeof DescribedPartSchema>;

export const DescriptorSchema = z.object({
    parts: z.array(DescribedPartSchema).min(1),
});

export type Descriptor = z.infer<typeof DescriptorSchema>;

/**
 * Parse a descriptor, or say exactly what is wrong with it.
 *
 * **The message names the file, the path and the problem**, because the person reading it is looking
 * at their own repository and a zod issue list on its own does not say which of their files it is
 * about. Keys beginning `//` are dropped before parsing — a comment convention in a format that has
 * none — and everything else unknown is an error.
 */
export function parseDescriptor(raw: string, where: string): Descriptor {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new ClientError(
            `${where}/${DESCRIPTOR_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    const result = DescriptorSchema.safeParse(stripComments(parsed));
    if (result.success) return result.data;

    const issues = result.error.issues
        .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n');

    /**
     * **`ClientError`, not `Error`** — a malformed descriptor is the caller's repository being wrong,
     * and answering 500 tells them the platform broke while hiding the one message that would let
     * them fix it. It reached a real import as `Internal server error` with the field name and the
     * problem sitting in the node's log, which is the exact failure `spec/errors.md` §1 exists for.
     */
    throw new ClientError(`${where}/${DESCRIPTOR_FILE} is not a valid descriptor:\n${issues}`);
}

/** Drop `//`-prefixed keys, recursively. */
function stripComments(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripComments);
    if (typeof value !== 'object' || value === null) return value;

    const kept: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        if (key.startsWith('//')) continue;
        kept[key] = stripComments(inner);
    }
    return kept;
}
