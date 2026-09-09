/**
 * **Seeding a site: one call, so a browser and a CLI do the same thing.**
 *
 * The pipeline — import, release, compose, grant, deploy — was `src/bring-up.ts`, a script that
 * joined the mesh as a peer and asserted an operator identity to make the calls. That is roadmap
 * **D6**: any peer completing the handshake constructs whatever meta it likes, so `requireOperator`
 * reads what the caller said about itself. D6's real fix is broker-level and is ⛔ mesh, and mesh is
 * frozen — so the door closes instead.
 *
 * *"I think site seed needs to be a server contract. If it's a contract both browser and CLI do the
 * same thing."* That is the argument, and it is stronger than tidiness: an orchestration living in
 * the CLI is one a console has to reimplement, and two implementations of *how a site is seeded*
 * drift in exactly the place where the drift is a site with the wrong grants.
 *
 * ## Whose site it is, is whoever called
 *
 * The new site's `tenantId` is the caller's organization and their membership is `owner`, so *"it
 * just becomes the admin account for the site"* is a consequence of who made the call rather than a
 * flag somebody sets. A site's admin has always been whoever holds `owner` in the organization that
 * owns it — this is the first thing that makes that true by construction.
 */

import { defineContract, z } from '@flybyme/mesh';

/** One repository to import parts from, and where its parts come from. */
const SourceSchema = z.object({
    repository: z.string().min(1).describe('A git URL, or a path to a bare repository'),
    ref: z.string().min(1).default('HEAD').describe('Branch or tag. Resolved to a commit at release'),
    subdirectory: z.string().min(1).optional().describe('For a monorepo'),
});

export const seedContract = defineContract({
    domain: 'site',
    action: 'seed',
    description:
        'Import repositories, release their parts, compose a release, and serve it on a hostname. '
        + 'The caller\'s organization owns the site.',

    inputSchema: z.object({
        host: z.string().min(1).describe('The hostname this will serve on'),
        /** Where the page sends its calls. Defaults to this node's api. */
        api: z.string().optional(),

        sources: z.array(SourceSchema).min(1).describe('Repositories to import parts from'),

        /**
         * **Which parts compose, rather than everything in the catalog.**
         *
         * A release is *a kernel and N parts at exact digests*, and which N is a decision about the
         * site. Composing everything is right for this platform's own console and wrong for
         * everything else: the first outside application landed on a page titled `Console` booting
         * nine parts, eight of them somebody else's consoles.
         *
         * Absent means everything imported, which is the old default and still the right one for a
         * console.
         */
        parts: z.array(z.string().min(1)).optional(),

        /** Namespaces the site's settings and names its page. Defaults to the single part's id. */
        application: z.string().min(1).optional(),
        title: z.string().min(1).optional(),
        releaseName: z.string().optional(),
        /** The kernel range to compose against. Defaults to the caret of what was released. */
        kernelRange: z.string().min(1).optional(),

        /**
         * The organization that will own this site, created if it does not exist.
         *
         * Absent, the caller's own resolved scope is used — which is what an operator who already
         * belongs somewhere means. On a cluster where the first operator belongs to nothing, this is
         * how the first tenant comes into being, and the caller becomes its owner.
         */
        organization: z.object({
            slug: z.string().min(1),
            name: z.string().min(1),
        }).optional(),

        /** Stop after the catalog knows what the parts are. Useful on a slow link. */
        importOnly: z.boolean().default(false),
    }),

    outputSchema: z.object({
        host: z.string(),
        siteId: z.string(),
        organizationId: z.string(),
        /** Absent when `importOnly`, or when nothing composed. */
        release: z.string().optional(),
        parts: z.array(z.object({
            name: z.string(),
            version: z.string(),
            kind: z.string(),
        })),
        /**
         * What went wrong, without stopping the rest.
         *
         * A part that failed to build is reported here and the seed stops before composing —
         * composing on a partial release produces a second, more confusing failure about a missing
         * artifact, several steps from the build that actually failed.
         */
        problems: z.array(z.string()),
    }),

    rest: { method: 'POST', path: '/sites/seed' },

    /**
     * **`public` means may-be-exposed; the control site gates this at `operator`.**
     *
     * Seeding decides what a hostname serves to the internet, so it is the same weight as
     * `cdn.deploy` — which is exposed for the same reason: a console that can list releases and not
     * create one is a viewer, and an operator who cannot seed from a browser is an operator with a
     * terminal requirement.
     */
    visibility: 'public',
    destructive: true,
    print: (o) => (o.release === undefined
        ? `${o.host}: ${String(o.parts.length)} part(s) imported${o.problems.length > 0 ? `, ${String(o.problems.length)} problem(s)` : ''}`
        : `${o.host} → ${o.release} (${String(o.parts.length)} part(s))`),
});
