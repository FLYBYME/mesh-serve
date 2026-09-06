/**
 * What the api answers over the mesh.
 *
 * Two contracts and **no collections** — this service owns nothing. What a site exposes is
 * `site.mesh`, owned by the cdn; tickets are identity's. These describe a projection of both.
 */

import { defineContract, z } from '@flybyme/mesh';

/**
 * What a hostname actually exposes, with its real gates.
 *
 * **This is the descriptor a client generator should read**, and it closes a gap the part-side
 * generator could not. A part declares the contracts it *calls* and cannot know their gates — a part
 * choosing its own gate would make installing one a privilege escalation — so `mesh-serve client`
 * uses one placeholder gate for every entry and its exposure hash is over *shapes*, not over the real
 * exposure. It therefore cannot be compared with what any API reports.
 *
 * This can. The gates are the site's, the hash is the one the api serves under, and a client built
 * from it refuses to speak to an API serving anything else.
 *
 * `public` because a client generator runs in CI with no credential, and because it discloses only
 * what the site already put on the internet: the routes, their shapes, and the gate in front of each.
 * A caller learning that `domains.zone_delete` requires `admin` has learned what any 401 would have
 * told them.
 */
export const describeContract = defineContract({
    domain: 'api',
    action: 'describe',
    description: 'What a hostname exposes: routes, shapes, and the gate in front of each.',
    inputSchema: z.object({
        host: z.string().min(1),
    }),
    outputSchema: z.object({
        host: z.string(),
        /** Where routes mount, so a generated client does not have to be told twice. */
        base: z.string(),
        exposure: z.string().describe('The hash a generated client carries and the api reports'),
        shapeHash: z.string().describe('The site-independent shape hash over contracts and schemas'),
        calls: z.array(z.object({
            key: z.string(),
            method: z.string(),
            path: z.string(),
            description: z.string(),
            gate: z.string().describe("`public`, `user`, `admin`, or `permission:<key>`"),
            destructive: z.boolean(),
            input: z.unknown().describe('JSON Schema'),
            output: z.unknown().describe('JSON Schema'),
        })),
        /**
         * Contracts the site names that no mounted module provides.
         *
         * Reported rather than hidden: a generator that silently omitted them would produce a client
         * missing calls its author declared, and the author would look for the mistake in their own
         * code.
         */
        unknown: z.array(z.string()),
    }),
    rest: { method: 'GET', path: '/api/describe' },
    visibility: 'public',
    print: (o) => `${o.host}: ${String(o.calls.length)} call(s), exposure ${o.exposure}`,
});
