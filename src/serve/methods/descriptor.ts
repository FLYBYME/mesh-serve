/**
 * What a site serves, rendered for a client.
 *
 * `spec/serving.md` §8. **One description, many renderings** — this is the shared computation, and a
 * projection turns it into routes, tools, refs or folders. Two copies of an exposure rule is how the
 * first one becomes wrong, and an exposure rule is not the one to find that out on.
 *
 * Pure. A site and the contracts a node has mounted go in; a description comes out.
 */

import { createHash } from 'node:crypto';

import { visibilityOf, type ToolContract, type z } from '@flybyme/mesh';

import { gateOf, type Site } from '../schema/site.js';

export interface DescribedCall {
    readonly key: string;
    readonly domain: string;
    readonly action: string;
    readonly description: string;
    readonly method: string;
    readonly path: string;
    /** The coarse level, or the permission name. One or the other, never both. */
    readonly gate: string;
    readonly input: z.ZodTypeAny;
    readonly output: z.ZodTypeAny;
    /** **What makes a UI ask before doing.** The contract's own declaration, not a guess at a verb. */
    readonly destructive: boolean;
    readonly errors: readonly string[];
}

export interface SiteDescription {
    readonly host: string;
    readonly title: string;
    readonly description: string;
    /** Changes when the surface changes and not otherwise, so a client can compare rather than diff. */
    readonly shapeHash: string;
    readonly calls: readonly DescribedCall[];
    /** Exposed contracts this node has not mounted, and internal ones it refused. §2. */
    readonly unserved: readonly { readonly key: string; readonly why: string }[];
}

/**
 * Build a site's description.
 *
 * **An exposure entry naming an internal contract is refused, not served**, and the refusal is
 * reported rather than silently dropped. That check has caught two real mistakes: a site exposing
 * `identity.ticket_issue` while the contract was still internal, and an extension declaring
 * `identity.ticket_revoke` — which takes a `userId` and ends every ticket a named person holds —
 * when it wanted a sign-out.
 *
 * The same goes for a contract this node has not mounted. Both belong in `unserved` where somebody
 * configuring a site can see them, because *"it does not appear and nothing said why"* is the
 * failure mode this whole file exists to prevent.
 */
export function describeSite(
    site: Site,
    mounted: ReadonlyMap<string, ToolContract<z.ZodTypeAny, z.ZodTypeAny>>,
): SiteDescription {
    const calls: DescribedCall[] = [];
    const unserved: { key: string; why: string }[] = [];

    for (const entry of site.contracts) {
        const contract = mounted.get(entry.key);
        if (contract === undefined) {
            unserved.push({ key: entry.key, why: 'this node has not mounted it' });
            continue;
        }

        if (visibilityOf(contract) !== 'public') {
            unserved.push({
                key: entry.key,
                why: 'marked internal by its own domain and cannot be exposed',
            });
            continue;
        }

        const gate = gateOf(entry);

        calls.push({
            key: entry.key,
            domain: contract.domain,
            action: contract.action,
            description: contract.description,
            method: contract.rest.method,
            path: contract.rest.path,
            gate: gate.kind === 'auth' ? gate.level : gate.permission,
            input: contract.inputSchema,
            output: contract.outputSchema,
            destructive: contract.destructive === true,
            errors: entry.errors,
        });
    }

    return {
        host: site.host,
        title: site.title,
        description: site.description,
        shapeHash: shapeHashOf(calls),
        calls,
        unserved,
    };
}

/**
 * A hash over the surface, and only over the surface.
 *
 * Sorted, so the order entries were written in does not change it. It covers the key, the route and
 * the gate — **the things a client breaks on** — and not the description, which is prose somebody
 * improves without changing what anything does.
 */
function shapeHashOf(calls: readonly DescribedCall[]): string {
    const surface = calls
        .map((c) => `${c.key} ${c.method} ${c.path} ${c.gate} ${String(c.destructive)}`)
        .sort()
        .join('\n');

    return createHash('sha256').update(surface).digest('hex').slice(0, 32);
}

/**
 * The description as JSON, for a client that is not this process.
 *
 * The zod schemas become JSON Schema at the projection boundary rather than here, because a git
 * client and a mail client want neither — this keeps the schemas as schemas for anything that can
 * use them directly.
 */
export function describedCallSummary(call: DescribedCall): Record<string, unknown> {
    return {
        key: call.key,
        description: call.description,
        method: call.method,
        path: call.path,
        gate: call.gate,
        destructive: call.destructive,
        errors: call.errors,
    };
}
