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
}).describe('Everything details.ts needs to provision one site end to end');
export type SiteSpec = z.infer<typeof siteSpecSchema>;
