/**
 * **What a seed may grant** — F30 stage 2, and the rule that keeps it from being an escalation.
 *
 * The interesting test here is the last one. `PLATFORM_DOMAINS` is a written list, and a written
 * list of security-relevant names goes stale exactly when somebody adds a domain — so it is scanned
 * against the source rather than trusted.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PLATFORM_DOMAINS, ceilingFor, domainOf, grantsToInstall } from '../../src/cdn/methods/ceiling.js';
import { installGrants } from '../../src/cdn/tools/seed.js';

describe('the ceiling', () => {
    it('keeps what the application defines', () => {
        expect(ceilingFor(['card.find', 'card.update', 'project.create']))
            .toEqual(['card.find', 'card.update', 'project.create']);
    });

    /**
     * The escalation this exists to stop.
     *
     * `release.requires` is derived from what the composed parts declare they call, and a part
     * declares its own requirements — so a manifest naming `cdn.deploy` would have it exposed on
     * that site, and a seed granting the site's whole exposed set would hand the platform's deploy
     * to a tenant role.
     */
    it('drops every domain this repository defines, however it got exposed', () => {
        const exposed = [
            'card.update',
            'cdn.deploy', 'site.create', 'identity.grant_role', 'node.status',
            'builder.release_repo', 'release.find', 'user.find',
        ];

        expect(ceilingFor(exposed)).toEqual(['card.update']);
    });

    it('drops the three every site is granted whether or not a part asked', () => {
        // ALWAYS_GRANTED is identity.* and telem.*, both platform domains. A tenant role holding
        // `identity.register` would be a tenant role that can make accounts on the cluster.
        expect(ceilingFor(['identity.register', 'identity.ticket_issue', 'telem.ingest']))
            .toEqual([]);
    });

    it('is a set, and sorted, so two seeds of one site produce one answer', () => {
        expect(ceilingFor(['b.two', 'a.one', 'b.two'])).toEqual(['a.one', 'b.two']);
    });

    it('reads a key with no dot as its own domain', () => {
        expect(domainOf('card.update')).toBe('card');
        expect(domainOf('card')).toBe('card');
    });
});

describe('what gets installed, and for which role', () => {
    const exposed = ['card.find', 'card.update', 'cdn.deploy', 'worktree.claim'];

    it('gives the organization owner everything the site serves that is theirs', () => {
        // F27: a hosted application whose owner cannot use it. `cdn.deploy` is not theirs.
        const grants = grantsToInstall(exposed, {});

        expect(grants).toEqual([
            { roleKey: 'owner', contract: 'card.find' },
            { roleKey: 'owner', contract: 'card.update' },
            { roleKey: 'owner', contract: 'worktree.claim' },
        ]);
    });

    it('gives a declared role what it declared, and only within the ceiling', () => {
        const grants = grantsToInstall(exposed, {
            planner: ['card.find', 'card.update'],
            // Declared and not served by this site: a row that could never be used, and one that
            // would come alive the day somebody exposed the contract for an unrelated reason.
            ghost: ['card.delete'],
        });

        const planner = grants.filter((g) => g.roleKey === 'planner').map((g) => g.contract);
        expect(planner).toEqual(['card.find', 'card.update']);
        expect(grants.some((g) => g.roleKey === 'ghost')).toBe(false);
    });

    it('refuses a part that tries to define `owner`', () => {
        // A part redefining `owner` would be widening or narrowing a role the platform assigns.
        const grants = grantsToInstall(exposed, { owner: ['cdn.deploy'] });

        expect(grants.every((g) => g.contract !== 'cdn.deploy')).toBe(true);
        expect(grants.filter((g) => g.roleKey === 'owner').map((g) => g.contract))
            .toEqual(['card.find', 'card.update', 'worktree.claim']);
    });

    it('cannot give a declared role a platform contract', () => {
        const grants = grantsToInstall(exposed, { planner: ['cdn.deploy', 'identity.grant_role'] });
        expect(grants.some((g) => g.roleKey === 'planner')).toBe(false);
    });
});

/**
 * **The list is scanned, not trusted.**
 *
 * A hand-written list of security-relevant names is right on the day it is written. Wrong in the
 * safe direction — naming a domain that does not exist — costs nothing. Wrong in the other
 * direction hands a platform contract to a tenant role, and the way it goes wrong is that somebody
 * adds a domain and never reads this file.
 */
describe('PLATFORM_DOMAINS covers every domain this repository defines', () => {
    it('names all of them', () => {
        const root = join(import.meta.dirname, '..', '..', 'src');
        const found = new Set<string>();

        const walk = (dir: string): void => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) { walk(path); continue; }
                if (!entry.name.endsWith('.contract.ts')) continue;

                const source = readFileSync(path, 'utf8');
                for (const m of source.matchAll(/\bdomain:\s*'([A-Za-z][A-Za-z0-9_]*)'/g)) {
                    found.add(m[1]!);
                }
                for (const m of source.matchAll(/\bdefineCrud\(\s*'([A-Za-z][A-Za-z0-9_]*)'/g)) {
                    found.add(m[1]!);
                }
            }
        };
        walk(root);

        // Proof the scan found anything at all: a scan that silently matches nothing passes every
        // assertion below it, which is the failure this whole test is written against.
        expect(found.size).toBeGreaterThan(10);

        const missing = [...found].filter((d) => !PLATFORM_DOMAINS.has(d)).sort();
        expect(missing, `add these to PLATFORM_DOMAINS in src/cdn/methods/ceiling.ts: ${missing.join(', ')}`)
            .toEqual([]);
    });
});

/**
 * **`installGrants` — the wiring, not the rule.**
 *
 * `ceiling.test.ts` proves what *should* be installed. This proves `site.seed` installs it, which is
 * the half that has gone missing four times in this repository: a rule with no caller reads exactly
 * like a rule that is enforced.
 *
 * It drives the function through a recording `call` rather than a cluster, because what is being
 * asserted is which broker calls it makes — `grant.find` once, then a `grant.create` per row that
 * is not already there, and none at all on a reseed.
 */
describe('seeding installs the grants, and does it once', () => {
    const exposed = ['card.find', 'card.update', 'cdn.deploy', 'identity.register'];

    const recorder = (existing: readonly { roleKey: string; contract: string }[] = []) => {
        const created: { roleKey: string; contract: string }[] = [];
        const roles: string[] = [];
        const call = async (tool: string, params: unknown): Promise<unknown> => {
            if (tool === 'identity.role_upsert') {
                roles.push((params as { key: string }).key);
                return { key: (params as { key: string }).key, created: true };
            }
            if (tool === 'grant.find') return existing;
            if (tool === 'grant.create') {
                created.push(params as { roleKey: string; contract: string });
                return {};
            }
            throw new Error(`unexpected call: ${tool}`);
        };
        return { created, roles, call };
    };

    it('creates a grant per role and contract inside the ceiling', async () => {
        const { created, call } = recorder();

        const added = await installGrants(call, undefined, exposed, { planner: ['card.find'] });

        expect(added).toBe(3);
        expect(created).toEqual([
            { roleKey: 'owner', contract: 'card.find' },
            { roleKey: 'owner', contract: 'card.update' },
            { roleKey: 'planner', contract: 'card.find' },
        ]);
        // The platform's own, exposed on this site and never granted to a tenant role.
        expect(created.some((g) => g.contract === 'cdn.deploy')).toBe(false);
        expect(created.some((g) => g.contract === 'identity.register')).toBe(false);
    });

    it('writes nothing on a reseed', async () => {
        // `site.seed` is documented idempotent and re-running it is the ordinary way to redeploy.
        // Existing rows are read rather than written-and-caught: `grant` is unique on
        // (roleKey, contract), so a blind create would throw CONFLICT every time and a catch around
        // it would swallow the conflicts that mean something else.
        const { created, call } = recorder([
            { roleKey: 'owner', contract: 'card.find' },
            { roleKey: 'owner', contract: 'card.update' },
        ]);

        const added = await installGrants(call, undefined, exposed, {});

        expect(added).toBe(0);
        expect(created).toEqual([]);
    });

    it('adds only what is new when a part starts declaring more', async () => {
        const { created, call } = recorder([{ roleKey: 'owner', contract: 'card.find' }]);

        const added = await installGrants(call, undefined, exposed, {});

        expect(added).toBe(1);
        expect(created).toEqual([{ roleKey: 'owner', contract: 'card.update' }]);
    });

    /**
     * **A grant on a role nobody defined is inert, and inert in the way that reads as policy.**
     *
     * `permits` skips a held key it cannot resolve — deliberately, so deleting a role does not take
     * every membership naming it out of service. So a grant for `planner` with no `planner` row
     * refuses the caller and says nothing about why. That is F32 exactly, and the first version of
     * this function repeated it: it installed grants for the declared roles and created none of them.
     */
    it('creates the role before granting to it, and never redefines `owner`', async () => {
        const { roles, call } = recorder();

        await installGrants(call, undefined, exposed, { planner: ['card.find'], worker: ['card.update'] });

        expect(roles).toEqual(['planner', 'worker']);
        // `owner` ships with identity (F32). A part redefining it would be changing a role the
        // platform assigns.
        expect(roles).not.toContain('owner');
    });

    it('asks identity nothing when there is nothing it may grant', async () => {
        // A site serving only the platform's own contracts has an empty ceiling, and a `grant.find`
        // for an answer that cannot be used is a query per seed for nothing.
        let asked = 0;
        const call = async (tool: string): Promise<unknown> => { asked += 1; return []; };

        expect(await installGrants(call, undefined, ['identity.register', 'telem.ingest'], {})).toBe(0);
        expect(asked).toBe(0);
    });
});
