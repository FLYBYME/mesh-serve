import { createRequire } from 'node:module';
import fs from 'node:fs';

import type { IPlacement, IServiceBroker, ToolContract } from '@flybyme/mesh';
import type { z } from 'zod';

import { CORE_PART_NAMES, type CorePartName } from '../contracts/corePart.contract.js';
import { corePartPath } from './corePartPath.js';

const require = createRequire(import.meta.url);

/**
 * Placement for mesh-serve's own core parts: a call for a contract this node doesn't have loads
 * the part that implements it, here, and then answers.
 *
 * This is what lets a node be genuinely bare. `start` brings up the catalog kernel and nothing
 * else; a second node joining an existing cluster needs no bootstrap and no load sequence of its
 * own -- the first call for `identity.whoami` loads identity on it. Before this, an unloaded part
 * meant an error, and something had to have known in advance to run the load.
 *
 * Only core parts. A third party's own service lives in the artifact store behind `serve.part.start`
 * and needs a `serve.part` row to find it; that is a separate provider and is not built yet, so
 * this declines anything it doesn't recognize and the call fails as it always did.
 */

/** domain -> the core part implementing it, built once from the bundles themselves. */
let domainIndex: Map<string, CorePartName> | undefined;

/**
 * Reads each bundle's own `domains` export rather than restating the mapping here.
 *
 * `require` evaluates the bundle, which registers its contracts with `globalContractRegistry` --
 * schema registration only, nothing mounted, nothing served. That side effect is not incidental,
 * it is half the point, and it is why this runs eagerly rather than on the first placement:
 *
 * **A node needs a contract's declaration to route to it, even when the implementation is
 * elsewhere.** The api gateway resolves an incoming request by looking up each `serve.expose`
 * row's contract (`gateway.ts`'s findRoute) to get its method and path. A node running only the
 * api would find nothing for `identity.ticket.issue`, skip the row, and answer 404 -- while the
 * node next to it, holding identical expose rows, answered 200. Found exactly that way, on the
 * first two-node run.
 *
 * `require.cache` makes the later real load free.
 */
function buildDomainIndex(): Map<string, CorePartName> {
    const index = new Map<string, CorePartName>();

    for (const name of CORE_PART_NAMES) {
        const path = corePartPath(name);
        if (!fs.existsSync(path)) continue;

        const bundle = require(path) as { domains?: readonly string[] };
        for (const domain of bundle.domains ?? []) {
            // First writer wins: two parts claiming one domain is a build-time mistake, and
            // silently flipping between them per boot would be worse than being consistent.
            if (!index.has(domain)) index.set(domain, name);
        }
    }

    return index;
}

/** `identity.user.create` -> `identity.user`, `identity.whoami` -> `identity`. */
function domainOf(toolName: string): string | undefined {
    const lastDot = toolName.lastIndexOf('.');
    return lastDot === -1 ? undefined : toolName.slice(0, lastDot);
}

export function createCorePartPlacement(broker: IServiceBroker): IPlacement {
    // Eagerly, at install time: every node then knows every core contract's declaration, which is
    // what routing to a contract implemented on another node requires. See buildDomainIndex.
    const index = domainIndex ??= buildDomainIndex();

    return {
        place: async (
            toolName: string,
            _contract: ToolContract<z.ZodTypeAny, z.ZodTypeAny> | undefined,
        ): Promise<string | undefined> => {
            const domain = domainOf(toolName);
            const part = domain === undefined ? undefined : index.get(domain);
            if (part === undefined) return undefined;

            // *A* node that can load core parts, not necessarily this one.
            //
            // This used to hardcode `broker.nodeID` -- "load it here" -- which quietly assumed the
            // caller is itself a node that hosts parts. A CLI or a short-lived client joining the
            // mesh is not: it would find nothing advertising the domain, have nowhere to place it,
            // and fail with a bare "no node in this mesh advertises domain identity" even though a
            // perfectly good node was sitting right there. Found running the compose example
            // against a cluster that had not loaded identity yet.
            //
            // `leaderFor`, not `placementFor`, and the distinction matters here: only a node that
            // actually advertises `serve.corePart` can load one, and a thin client does not. That
            // filter is exactly what leaderFor applies, so it excludes clients by construction
            // rather than by a check someone has to remember.
            const host = broker.registry.leaderFor('serve.corePart');
            if (host === undefined) return undefined;

            try {
                // Explicitly addressed, which is what IPlacement requires of a provider: an
                // unaddressed call for a tool that is itself unplaced would re-enter placement.
                const { nodeID } = await broker.call('serve.corePart.load', { name: part }, { nodeID: host.nodeID });
                return nodeID;
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (/already running/i.test(message)) {
                    // The part is loaded and still doesn't serve this tool, so loading it again
                    // would not help. Declining is the honest answer: the caller gets "nobody
                    // serves this", which is exactly right.
                    return undefined;
                }
                throw err;
            }
        },
    };
}

/** Test seam -- the index is built once per process from files that don't change at runtime. */
export function resetCorePartPlacementIndex(): void {
    domainIndex = undefined;
}
