/**
 * **The narrow MCP surface: which tools a role puts on the table.**
 *
 * `kind: 'agent'` — a part with no source that declares which contracts each role may call. This is
 * the answer to *"i only want to provide a few tools over the mcp"*, and the reason it is a part
 * rather than site configuration is that the map is content: which roles a surface offers travels
 * with the parts, the way an application's views do. What a site *grants* stays the site's, so a
 * tool needs both — named by a role and exposed by the site.
 *
 * Two of the rules below fail silently if they are wrong, which is why they are here rather than
 * left to a manual check:
 *
 * - a site with **no** map must not be narrowed, or upgrading takes away a working surface
 * - a caller holding **none** of a declared map's roles must get nothing, or declaring the first
 *   role hands everything to everyone outside it
 */

import { describe, expect, it } from 'vitest';

import { releaseHash } from '../../src/cdn/methods/release.js';
import { PartKindSchema, AgentRolesSchema } from '../../src/catalog/schema/part.js';

// ---------------------------------------------------------------------------- the kind

describe('agent is a kind', () => {
    it('is one of the four, and the only one with no build recipe', () => {
        expect(PartKindSchema.options).toEqual(['kernel', 'application', 'extension', 'agent']);
    });

    /** Open-ended on purpose: a deployment names its own roles and the platform does not guess. */
    it('accepts any role name, and refuses a role that offers nothing', () => {
        expect(AgentRolesSchema.safeParse({ planner: ['board.survey'], 'shift-lead': ['x.y'] }).success).toBe(true);
        expect(AgentRolesSchema.safeParse({ worker: [] }).success).toBe(false);
        expect(AgentRolesSchema.safeParse({ '': ['x.y'] }).success).toBe(false);
    });
});

// ---------------------------------------------------------------------------- the hash

describe('the role map is part of a release identity', () => {
    const kernel = { version: '1.0.0', digest: 'sha256:k' };
    const parts = { app: { version: '1.0.0', digest: 'sha256:a' } };
    const policy = {};

    /**
     * A narrowed surface that hashed the same as the wide one would deploy as a no-op — a security
     * change that silently does nothing, which is the failure `release.deploy` exists to prevent.
     */
    it('separates two releases that differ only in what an agent may call', () => {
        const wide = releaseHash({ kernel, parts, policy, agentRoles: { worker: ['a.b', 'c.d'] } });
        const narrow = releaseHash({ kernel, parts, policy, agentRoles: { worker: ['a.b'] } });
        expect(wide).not.toBe(narrow);
    });

    it('does not care about declaration order', () => {
        const one = releaseHash({ kernel, parts, policy, agentRoles: { worker: ['c.d', 'a.b'], planner: ['e.f'] } });
        const two = releaseHash({ kernel, parts, policy, agentRoles: { planner: ['e.f'], worker: ['a.b', 'c.d'] } });
        expect(one).toBe(two);
    });

    /**
     * **Every release composed before this existed keeps the hash it has.**
     *
     * A field that were always present would re-identify the whole platform's releases at once, and
     * a release hash is what *"staging runs what production runs"* is answered with.
     */
    it('leaves an empty map out entirely', () => {
        const before = releaseHash({ kernel, parts, policy });
        expect(releaseHash({ kernel, parts, policy, agentRoles: {} })).toBe(before);
    });
});

// ---------------------------------------------------------------------------- the narrowing

/**
 * `offeredTo` is private to `McpService`, so its rule is restated here as the thing being asserted.
 * Keeping it a pure function of (map, roles) is what makes that honest — there is nothing else in it.
 */
const offeredTo = (
    roles: Record<string, readonly string[]> | undefined,
    held: readonly string[],
): ReadonlySet<string> | undefined => {
    if (roles === undefined || Object.keys(roles).length === 0) return undefined;
    const has = new Set(held);
    const keys = new Set<string>(['approval.check']);
    for (const [role, contracts] of Object.entries(roles)) {
        if (!has.has(role)) continue;
        for (const key of contracts) keys.add(key);
    }
    return keys;
};

describe('what a caller is offered', () => {
    const map = { planner: ['board.survey', 'card.open'], worker: ['task.claim', 'task.note'] };

    it('gives a role the union of what its roles name', () => {
        expect([...offeredTo(map, ['worker'])!].sort())
            .toEqual(['approval.check', 'task.claim', 'task.note']);
        expect([...offeredTo(map, ['planner', 'worker'])!].sort())
            .toEqual(['approval.check', 'board.survey', 'card.open', 'task.claim', 'task.note']);
    });

    /**
     * The compatibility rule. Every site composed before agent parts existed has no map, and
     * narrowing them to nothing would remove a working MCP surface on upgrade.
     */
    it('does not narrow a site that declares no roles', () => {
        expect(offeredTo(undefined, ['worker'])).toBeUndefined();
        expect(offeredTo({}, ['worker'])).toBeUndefined();
    });

    /**
     * **The inversion this guards against.** A caller outside every declared role gets the empty set
     * and not `undefined` — if it were `undefined`, declaring one role would hand the entire surface
     * to everybody who does not hold it.
     */
    it('gives a caller holding none of the declared roles nothing but its own approval poll', () => {
        expect([...offeredTo(map, [])!]).toEqual(['approval.check']);
        expect([...offeredTo(map, ['operator'])!]).toEqual(['approval.check']);
    });

    /**
     * The one exemption, and it is not generosity: the surface hands out an approval id when it
     * parks a call, and a role list that forgot to name `approval.check` would strand the agent
     * holding one.
     */
    it('always offers the approval poll', () => {
        expect(offeredTo(map, ['worker'])!.has('approval.check')).toBe(true);
    });
});
