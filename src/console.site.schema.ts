/**
 * The shape of a site spec -- what details.ts needs to provision one site (repos, parts, exposed
 * contracts) end to end. Real zod, not just TS types: the data itself lives in a JSON file
 * (console.site.json) a person can hand-edit, and a hand-edited file is exactly the kind of input
 * that should fail loudly and precisely on load rather than surface as a confusing broker.call
 * error three steps into provisioning.
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

export const partSpecSchema = z.object({
    repoName: z.string().min(1).describe('Which repos[].name this part is built from'),
    key: z.string().min(1).describe('Namespaced "org-slug/part-name", the identifier other records point at'),
    kind: partKindSchema,
    path: z.string().min(1).describe("Subdirectory within the repo; '.' means the repo root"),
    entryPoint: z.string().min(1),
    imports: z.string().optional().describe('The bare specifier other parts reach this one by, if any'),
    wants: z.array(z.string()).describe('Contract keys this part calls'),
    description: z.string(),
    // Pinned commit sha this part builds from. Absent means "whatever repos[].ref (a branch)
    // currently resolves to" -- sync.ts resolves that branch to a concrete sha itself (git
    // ls-remote) before building, so the artifact cache below is always keyed by a real commit,
    // never a moving branch name that would silently go stale.
    ref: z.string().min(1).optional().describe("Pinned commit sha; falls back to the repo's own ref (a branch) when absent"),
    // Passed to this part's constructor as its PartRef.options (mesh-web kernel/start.ts) -- the
    // site's decision, never the part's own. Must be JSON-serializable: it ends up baked into the
    // generated boot module as a literal (cdn.service.ts), not handed a live object at runtime.
    options: z.record(z.string(), z.unknown()).optional().describe("Constructor options for this part, e.g. { persist: true } for platform/auth"),
}).describe("One buildable part of the site's composition");
export type PartSpec = z.infer<typeof partSpecSchema>;

export const siteSpecSchema = z.object({
    cdn: z.string().min(1).describe('The frontend hostname this site serves'),
    theme: z.string().min(1).describe('The key of the theme part this site composes, if any'),
    api: z.string().min(1).describe('The api hostname this site calls'),
    repos: z.array(repoSpecSchema),
    parts: z.array(partSpecSchema),
    exposed: z.array(z.string()).describe('Every domain.action contract the api exposes'),
    // Where sync.ts writes this site's generated client. A site declares its own, rather than a
    // separate script maintaining a {site path -> out path} list that can drift the same way the
    // hand-maintained `exposed` list already drifted once (console.site.json missing
    // identity.ticket.signOut while git.site.json had it, found live) -- a --out CLI flag still
    // overrides this for a one-off. Absent means "this site has no generated client to write"
    // (not every site necessarily calls exposed contracts of its own).
    generatedClientOut: z.string().min(1).optional().describe("Absolute path sync.ts writes this site's generated client to, unless --out overrides it"),
    /**
     * Values frozen into this deployment -- matches `serve.cdn`'s own `policy` field and mesh-web's
     * `BuildPolicy` exactly (`{ "window-manager/mode": "single" }` is how a blog is locked). Absent
     * means `{}`, the same as every site before this existed: nothing frozen, mesh-web's own default
     * (windowed) applies and a person can change it.
     *
     * This was previously unreachable from a site spec at all -- `syncSite` hardcoded `policy: {}` on
     * create and never sent `policy` on update, even though the DB schema, the generated boot script,
     * mesh-web's `WindowManager` and (as of this session) `ConsoleChrome` all already supported a
     * locked single mode end to end. Found live, looking for exactly this field while trying to
     * actually build a "blog" site.
     */
    policy: z.record(z.string(), z.unknown()).optional().describe('Values frozen into this deployment, e.g. { "window-manager/mode": "single" } to lock a blog'),
}).describe('Everything details.ts needs to provision one site end to end');
export type SiteSpec = z.infer<typeof siteSpecSchema>;
