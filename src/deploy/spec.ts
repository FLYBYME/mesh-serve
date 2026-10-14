/**
 * A site file, `<name>.site.yaml`: everything `mesh-serve deploy` needs to put one site on one api
 * -- its api and what that exposes, the repos and parts it is built from, its pages, and the
 * generated clients it was typechecked against. Hand-written YAML, so a gate or a part can carry a
 * comment saying why; validated here, so a bad edit fails on load with the path to the field.
 *
 * It was `sync`'s site spec (console.site.schema.ts); deploy added what the per-site deploy scripts
 * knew and sync did not: pages, the clients to check, and which repo is this checkout.
 */
import fs from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';

export const repoSpecSchema = z.object({
    name: z.string().min(1).describe('Short local name other parts reference this repo by'),
    url: z.string().min(1).describe('The git remote URL to clone or fetch from'),
    ref: z.string().min(1).describe("Branch a part builds from when it doesn't name its own ref"),
    kernel: z.boolean().optional().describe('Marks the repo that hosts the kernel part'),
    local: z.boolean().optional()
        .describe('This checkout: its parts build at the commit deploy checked (HEAD, which must be on origin), never a moving branch'),
    credential: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/).optional()
        .describe('A private repo: the name of the credential its builds clone with (serve.repo.credential; SurfDNS: a vault secret) -- a name, never the token'),
}).describe("A git repository the site's parts are sourced from");
export type RepoSpec = z.infer<typeof repoSpecSchema>;

export const partKindSchema = z.enum(['kernel', 'application', 'extension', 'driver', 'theme', 'service']);
export type PartSpecKind = z.infer<typeof partKindSchema>;

/**
 * Desired state for a `kind: service` part, the only kind that runs rather than being composed into
 * a page: declared, and the supervisor keeps it so -- never started once by hand.
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
    ref: z.string().min(1).optional().describe("A pinned commit or tag; else the repo's own ref (a local repo: the checked commit)"),
    options: z.record(z.string(), z.unknown()).optional().describe('Constructor options for this part -- the site\'s decision, never the part\'s own'),
    desired: partDesiredSchema.optional().describe('kind: service only -- what the supervisor keeps it at'),
}).describe("One buildable part of the site's composition");
export type PartSpec = z.infer<typeof partSpecSchema>;

/**
 * What a caller must be to reach one exposed contract. `public` is spelled out, never what an
 * omitted gate means: an omitted gate once made every exposed collection anonymously writable.
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

export const pageSpecSchema = z.object({
    path: z.string().regex(/^\//, 'A path from the site\'s root, like /pricing'),
    title: z.string().min(1),
    description: z.string(),
    index: z.boolean().default(true).describe('false: kept out of search engines and the sitemap'),
}).describe('A public page of the site, with its own head and sitemap entry');
export type PageSpec = z.infer<typeof pageSpecSchema>;

export const clientSpecSchema = z.object({
    file: z.string().min(1).describe('A generated client in this checkout, e.g. src/generated/api.ts'),
    api: z.string().min(1).optional().describe('The api host it must match; absent, this site\'s api.host'),
}).describe('A generated client this site is typechecked against: deploy refuses while it no longer matches its api');
export type ClientSpec = z.infer<typeof clientSpecSchema>;

export const siteSpecSchema = z.object({
    site: z.string().min(1).describe('The frontend hostname this site serves'),
    org: z.string().min(1).default('platform').describe('Slug of the identity.organization that owns all of this'),
    title: z.string().default('').describe('The page title; empty falls back to the application'),
    description: z.string().default('').describe('Empty means no description meta tags'),
    indexable: z.boolean().default(false).describe('false adds noindex, nofollow: a console or a rehearsal'),
    canonical: z.string().url().optional(),
    pages: z.array(pageSpecSchema).default([]),
    open: z.array(z.object({
        application: z.string().min(1),
        views: z.array(z.string()).optional(),
    })).optional().describe('What the page opens; absent, every application part, as declared'),
    api: z.object({
        host: z.string().min(1).describe('The api hostname this site calls'),
        // Absent is not empty: absent leaves the api's rows as they are; a list (even []) is the
        // whole set, and rows not in it are removed. An `expose: []` written by mistake would have
        // removed sign-in from api.one-host.ca (10-14, the first dry run).
        expose: z.array(exposeSpecSchema).optional()
            .describe('Every row this api has, each with its gate; rows not listed are removed. Absent: the rows are left alone'),
    }).describe('The api this site talks to, and its exposed surface'),
    clients: z.array(clientSpecSchema).default([]),
    typecheck: z.array(z.string().min(1)).min(1).default(['npx', 'tsc', '-p', 'tsconfig.json', '--noEmit'])
        .describe('The command that typechecks this checkout, as argv'),
    theme: z.string().min(1).optional().describe('The key of the theme part this site composes, if any'),
    repos: z.array(repoSpecSchema),
    parts: z.array(partSpecSchema),
    policy: z.record(z.string(), z.unknown()).optional().describe('Values frozen into this deployment, e.g. { "window-manager/mode": "single" }'),
}).describe('Everything deploy needs to put one site on one api');
export type SiteSpec = z.infer<typeof siteSpecSchema>;

export function loadSite(sitePath: string): SiteSpec {
    const raw = fs.readFileSync(sitePath, 'utf-8');
    const parsed: unknown = YAML.parse(raw);

    return siteSpecSchema.parse(parsed);
}
