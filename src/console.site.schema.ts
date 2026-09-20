/**
 * The shape of a site spec -- what `sync` needs to provision one site (repos, parts, exposure)
 * end to end. Real zod, not just TS types: the data lives in a file a person hand-edits, and a
 * hand-edited file is exactly the kind of input that should fail loudly and precisely on load
 * rather than surface as a confusing broker.call error three steps into provisioning.
 *
 * YAML is the hand-written format (see console.site.ts's loader, which still reads JSON too).
 * Dumping a live site back out goes to JSON, deliberately -- no YAML serializer preserves
 * comments, and comments are most of why this file is YAML at all.
 */
import { z } from 'zod';

export const repoSpecSchema = z.object({
    name: z.string().min(1).describe('Short local name other parts reference this repo by'),
    url: z.string().min(1).describe('The git remote URL to clone or fetch from'),
    ref: z.string().min(1).describe("Branch a part builds from when it doesn't name its own ref"),
    kernel: z.boolean().optional().describe('Marks the repo that hosts the kernel part, if relevant'),
}).describe("A git repository the site's parts are sourced from");
export type RepoSpec = z.infer<typeof repoSpecSchema>;

export const partKindSchema = z.enum(['kernel', 'application', 'extension', 'driver', 'theme', 'service']);
export type PartSpecKind = z.infer<typeof partKindSchema>;

/**
 * Desired state for a `kind: service` part, which is the only kind that *runs* rather than being
 * composed into a page.
 *
 * Declared rather than started: `serve.part.start` runs a service on whichever node the call
 * happens to reach, once, with nothing recording that it should still be running -- so when that
 * node dies the service simply stops existing and nothing notices. `serve.part.desired` is what the
 * supervisor reconciles against, and a spec that means "this should be running" should say that
 * rather than issue a start.
 */
export const partDesiredSchema = z.enum(['running', 'stopped']);

export const partSpecSchema = z.object({
    repo: z.string().min(1).describe('Which repos[].name this part is built from'),
    key: z.string().min(1).describe('Namespaced "org-slug/part-name", the identifier other records point at'),
    kind: partKindSchema,
    path: z.string().min(1).default('.').describe("Subdirectory within the repo; '.' (the default) means the repo root"),
    entry: z.string().min(1).describe('Entry point within `path`, e.g. src/index.ts'),
    imports: z.string().optional().describe('The bare specifier other parts reach this one by, if any'),
    description: z.string().optional(),
    // Pinned commit sha this part builds from. Absent means "whatever repos[].ref (a branch)
    // currently resolves to" -- sync resolves that branch to a concrete sha itself (git ls-remote)
    // before building, so the artifact cache is always keyed by a real commit, never a moving
    // branch name that would silently go stale.
    ref: z.string().min(1).optional().describe("Pinned commit sha; falls back to the repo's own ref (a branch) when absent"),
    // Passed to this part's constructor as its PartRef.options (mesh-web kernel/start.ts) -- the
    // site's decision, never the part's own. Must be JSON-serializable: it ends up baked into the
    // generated boot module as a literal, not handed a live object at runtime.
    options: z.record(z.string(), z.unknown()).optional().describe("Constructor options for this part, e.g. { persist: true } for platform/auth"),
    desired: partDesiredSchema.optional().describe('For kind: service only -- what the supervisor should reconcile this part to'),
}).describe("One buildable part of the site's composition");
export type PartSpec = z.infer<typeof partSpecSchema>;

/**
 * What a caller must be to reach one exposed contract.
 *
 * `public` is spelled out rather than being what you get by leaving the field off, and that is the
 * entire point of this type. The previous spec listed exposure as bare contract strings, and
 * `syncExposed` passed no role at all -- so every contract a site exposed was ungated. The tools
 * survived on their own `permissions` floors, but the CRUD collections declare `permissions: []`,
 * which meant a site listing `serve.repo.create` was exposing an anonymous write and nothing
 * anywhere said so. Making the gate required turns that from a silent default into a decision
 * somebody typed.
 *
 * The contract's own `permissions` is a floor beneath this and both apply: a row can demand more
 * than the contract does, never less.
 */
export const exposeSpecSchema = z.object({
    contract: z.string().min(1).describe('The domain.action key to expose'),
    gate: z.union([
        z.literal('public').describe('Reachable with no credential at all -- say so deliberately'),
        z.object({ role: z.string().min(1) }).describe('An identity.role key the caller must hold in this api\'s organization'),
        z.object({ permission: z.string().min(1) }).describe('Checked against the caller\'s resolved role permissions'),
    ]).describe('What a caller must be. Required: an omitted gate used to mean "anonymous".'),
    why: z.string().optional().describe('Why this is exposed -- for the reader, not the machine'),
}).describe('One contract this api exposes, and the gate on it');
export type ExposeSpec = z.infer<typeof exposeSpecSchema>;

export const siteSpecSchema = z.object({
    site: z.string().min(1).describe('The frontend hostname this site serves'),
    org: z.string().min(1).default('platform').describe('Slug of the identity.organization that owns all of this'),
    api: z.object({
        host: z.string().min(1).describe('The api hostname this site calls'),
        expose: z.array(exposeSpecSchema).default([]),
    }).describe('The api this site talks to, and its exposed surface'),
    theme: z.string().min(1).optional().describe('The key of the theme part this site composes, if any'),
    repos: z.array(repoSpecSchema),
    parts: z.array(partSpecSchema),
    /**
     * Values frozen into this deployment -- matches `serve.cdn`'s own `policy` field and mesh-web's
     * `BuildPolicy` exactly (`{ "window-manager/mode": "single" }` is how a blog is locked). Absent
     * means `{}`: nothing frozen, mesh-web's own default (windowed) applies and a person can change
     * it.
     */
    policy: z.record(z.string(), z.unknown()).optional().describe('Values frozen into this deployment, e.g. { "window-manager/mode": "single" } to lock a blog'),
}).describe('Everything sync needs to provision one site end to end');
export type SiteSpec = z.infer<typeof siteSpecSchema>;
