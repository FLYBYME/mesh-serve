/**
 * The grant check in `cdn.deploy` — the one thing standing between a part and a 404 nobody can read.
 *
 * A release says what its parts **call**. A site says what it **exposes and at what gate**. Neither
 * can check the other alone, so the comparison happens at the one moment both are in hand: deploy.
 *
 * `checkComposition` is tested next door as a pure function, and this is *not* that. This is the
 * check `cdn_deploy` makes itself, against a real site record and a real release row — the one that
 * fired in production on 2026-09-07:
 *
 *     [cdn] 169.197.131.82 stayed on sha256:c48669…: 169.197.131.82 does not expose
 *     builder.import_repo, builder.release_part, builder.release_repo, catalog.declare,
 *     and this release calls them.
 *
 * It is worth its own tests now rather than later, because **C11 makes it load-bearing twice**:
 * loading a part on demand needs exactly this comparison, made per part instead of per release, and
 * a check about to be reused in a second place should be pinned in the first.
 */

import { ClientError } from '@flybyme/mesh';
import { describe, expect, it } from 'vitest';

import { cdn_deploy } from '../../src/cdn/tools/deploy.js';
import type { CdnService } from '../../src/cdn/cdn.service.js';

const TENANT = 'org-1';

interface World {
    readonly site: Record<string, unknown>;
    readonly release: Record<string, unknown>;
}

/**
 * A context that answers with one site and one release, and records what was written.
 *
 * `cdn_deploy` reaches for `site.find_one`, `release.find_one` and `site.update` and nothing else,
 * so a Map of answers is the whole harness — no database, no cluster, milliseconds.
 */
function contextFor(world: World) {
    const calls: { tool: string; params: Record<string, unknown> }[] = [];
    const emitted: string[] = [];

    const ctx = {
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        emit: (name: string) => { emitted.push(name); },
        call: async (tool: string, params: Record<string, unknown>) => {
            calls.push({ tool, params });
            if (tool === 'site.find_one') return world.site;
            if (tool === 'release.find_one') return world.release;
            return undefined;
        },
    };

    return { ctx, calls, emitted, wrote: () => calls.filter((c) => c.tool === 'site.update') };
}

const siteWith = (contracts: readonly string[]): Record<string, unknown> => ({
    id: 's1',
    host: 'console.test',
    tenantId: TENANT,
    mesh: [{
        package: '@flybyme/mesh-serve',
        version: '^0.1',
        contracts: contracts.map((key) => ({ key, auth: 'user' })),
        events: [],
    }],
});

const releaseWith = (requires: readonly string[]): Record<string, unknown> => ({
    id: 'r1',
    hash: 'sha256:new',
    tenantId: TENANT,
    requires: [...requires],
});

const deploy = (world: World, hash = 'sha256:new'): Promise<unknown> =>
    cdn_deploy.call({} as CdnService, { host: 'console.test', release: hash }, contextFor(world).ctx as never);

describe('a release may not call what the site does not expose', () => {
    it('refuses, and names every ungranted contract at once', async () => {
        // All of them, not the first: somebody adding four contracts wants four answers, and
        // discovering them one deploy at a time is four round trips.
        const world = {
            site: siteWith(['part.find']),
            release: releaseWith(['part.find', 'catalog.declare', 'builder.release_repo']),
        };

        await expect(deploy(world)).rejects.toThrow(/catalog\.declare.*builder\.release_repo|builder\.release_repo/s);

        try {
            await deploy(world);
        } catch (error) {
            const client = error as ClientError;
            expect(client.code).toBe('contract_not_exposed');
            expect(client.status).toBe(409);
            // The message has to say what to do about it. A refusal naming a contract but not the
            // remedy sends somebody to read the source of a deploy tool.
            expect(client.message).toMatch(/add .* to the site's mesh list with a gate/);
        }
    });

    it('does not deploy when it refuses', async () => {
        /**
         * The property that matters more than the message. A partial deploy — the site pointed at a
         * release whose contracts it does not expose — is exactly the state the check exists to
         * prevent, and a check that throws *after* writing prevents nothing.
         */
        const world = { site: siteWith([]), release: releaseWith(['part.find']) };
        const probe = contextFor(world);

        await cdn_deploy.call({} as CdnService, { host: 'console.test', release: 'sha256:new' }, probe.ctx as never)
            .catch(() => undefined);

        expect(probe.wrote()).toHaveLength(0);
        expect(probe.emitted).toHaveLength(0);
    });

    it('deploys when every requirement is granted', async () => {
        const world = {
            site: siteWith(['part.find', 'site.find']),
            release: releaseWith(['part.find']),
        };
        const probe = contextFor(world);

        const answer = await cdn_deploy.call(
            {} as CdnService, { host: 'console.test', release: 'sha256:new' }, probe.ctx as never,
        ) as { changed: boolean; unusedGrants: string[] };

        expect(answer.changed).toBe(true);
        expect(probe.wrote()).toHaveLength(1);

        // A grant nothing calls is reported and never refused: the route somebody left behind when
        // they deleted the screen that used it.
        expect(answer.unusedGrants).toEqual(['site.find']);
    });

    it('is satisfied by a grant at any gate, because the gate is a different question', async () => {
        // The check asks *is this exposed at all*. What gate it sits behind is the site's decision
        // and is enforced per request — conflating them would make raising a gate break a deploy.
        const world = {
            site: {
                ...siteWith([]),
                mesh: [{
                    package: '@flybyme/mesh-serve',
                    version: '^0.1',
                    contracts: [{ key: 'part.find', auth: 'operator' }],
                    events: [],
                }],
            },
            release: releaseWith(['part.find']),
        };

        await expect(deploy(world)).resolves.toMatchObject({ changed: true });
    });

    it('refuses another tenant\'s release as not found, never as forbidden', async () => {
        /**
         * The origin is the isolation boundary: serving another tenant's composition would put
         * their code in this origin, with its storage and its cookies. 404 rather than 403, because
         * whether a release exists is not something an unrelated caller gets to confirm by probing.
         */
        const world = {
            site: siteWith(['part.find']),
            release: { ...releaseWith(['part.find']), tenantId: 'org-2' },
        };

        try {
            await deploy(world);
            throw new Error('should have refused');
        } catch (error) {
            const client = error as ClientError;
            expect(client.code).toBe('release_not_found');
            expect(client.status).toBe(404);
            expect(client.message).not.toMatch(/forbidden|not allowed|permission/i);
        }
    });
});
