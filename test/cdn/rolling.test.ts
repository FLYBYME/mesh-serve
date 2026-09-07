/**
 * Rolling releases.
 *
 * The one place in the system where a deploy happens without a person asking for it, so the tests
 * are about **what it refuses to do** as much as what it does: it must not touch a release that is
 * not rolling, must not cross a tenant, must not move a site when the composition did not change,
 * and must not mutate the release it rolled off — that release is what rollback goes back to.
 *
 * No database and no cluster. `rollForPart` takes a context and makes calls, so a recording fake is
 * the whole harness, and every one of these runs in milliseconds.
 */

import { describe, expect, it } from 'vitest';

import { follows, rollForPart, type PartReleased } from '../../src/cdn/methods/rolling.js';
import type { Release } from '../../src/cdn/contracts/release.contract.js';

const RELEASED: PartReleased = {
    tenantId: 'org-1',
    part: 'chrome',
    kind: 'extension',
    version: '0.2.5',
    commit: 'a'.repeat(40),
};

const release = (over: Partial<Release> = {}): Release => ({
    id: 'r1',
    hash: 'sha256:old',
    name: 'console',
    tenantId: 'org-1',
    kernel: { version: '0.15.10', digest: 'sha256:kernel' },
    parts: { chrome: { version: '0.2.4', digest: 'sha256:chrome' } },
    requires: [],
    policy: {},
    rolling: true,
    source: {
        kernel: '^0.15',
        parts: [{ kind: 'extension', id: 'chrome', version: '^0.2' }],
    },
    composedAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
} as Release);

interface Recorded { tool: string; params: Record<string, unknown> }

/**
 * A context that records what was called and answers from a script.
 *
 * `compose` returns the hash it is told to, so a test says *the world changed* or *nothing moved*
 * without composing anything.
 */
function fakeContext(options: {
    releases: readonly Release[];
    composedHash: string;
    problems?: readonly { kind: string; message: string }[];
    sites?: readonly { id: string; host: string }[];
    deployThrows?: string;
}) {
    const calls: Recorded[] = [];
    const emitted: Recorded[] = [];

    const ctx = {
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        emit: (name: string, payload: unknown) => {
            emitted.push({ tool: name, params: payload as Record<string, unknown> });
        },
        call: async (tool: string, params: Record<string, unknown>) => {
            calls.push({ tool, params });

            switch (tool) {
                case 'release.find':
                    return options.releases;
                case 'cdn.compose':
                    return {
                        hash: options.composedHash,
                        kernel: { version: '0.15.11', digest: 'sha256:k2' },
                        parts: {},
                        existed: false,
                        problems: options.problems ?? [],
                    };
                case 'release.find_one':
                    return { id: 'r2', hash: options.composedHash, rolling: false };
                case 'site.find':
                    return options.sites ?? [];
                case 'cdn.deploy':
                    if (options.deployThrows !== undefined) throw new Error(options.deployThrows);
                    return { changed: true };
                default:
                    return undefined;
            }
        },
    };

    const called = (tool: string) => calls.filter((call) => call.tool === tool);
    return { ctx, calls, emitted, called };
}

describe('which releases follow a released part', () => {
    it('follows a part named in the ranges it was composed from', () => {
        expect(follows(release(), RELEASED)).toBe(true);
    });

    it('does not follow a part it never named', () => {
        expect(follows(release(), { part: 'unrelated', kind: 'extension' })).toBe(false);
    });

    it('follows every kernel release', () => {
        // A release names exactly one kernel, by range, and the catalog refuses to resolve when more
        // than one is published — so there is no ambiguity to narrow here.
        expect(follows(release(), { part: 'mesh-web', kind: 'kernel' })).toBe(true);
    });

    it('does not follow when the ranges were never recorded', () => {
        /**
         * Releases composed before `source` existed cannot roll, and are skipped rather than rolled
         * from a guess. Recovering `^0.15` from a pinned `0.15.10` is guessing at what somebody
         * meant, on the field that decides what runs on a hostname.
         */
        const old = release();
        expect(follows({ ...old, source: undefined } as Release, RELEASED)).toBe(false);
    });
});

describe('rolling a release', () => {
    it('composes, supersedes the old release and moves its sites', async () => {
        const world = fakeContext({
            releases: [release()],
            composedHash: 'sha256:new',
            sites: [{ id: 's1', host: 'console.surfdns.net' }],
        });

        await rollForPart(world.ctx as never, RELEASED);

        expect(world.called('cdn.compose')[0]?.params['kernel']).toBe('^0.15');

        // The old release is marked, never rewritten: it still names the digests it always did, so
        // rollback stays one write backwards to a release that is still there.
        const update = world.called('release.update')[0];
        expect(update?.params).toMatchObject({ rolling: false, supersededBy: 'sha256:new' });

        expect(world.called('cdn.deploy')[0]?.params).toMatchObject({
            host: 'console.surfdns.net', release: 'sha256:new',
        });

        expect(world.emitted[0]?.tool).toBe('cdn.release_rolled');
        expect(world.emitted[0]?.params['hosts']).toEqual(['console.surfdns.net']);
    });

    it('does nothing when the composition did not change', async () => {
        // The ordinary case for a part rebuilt to identical bytes — and the reason the trigger can
        // afford to be *a release happened* rather than *new bytes exist*.
        const world = fakeContext({ releases: [release()], composedHash: 'sha256:old' });

        await rollForPart(world.ctx as never, RELEASED);

        expect(world.called('release.update')).toHaveLength(0);
        expect(world.called('cdn.deploy')).toHaveLength(0);
        expect(world.emitted).toHaveLength(0);
    });

    it('leaves another tenant\'s release alone', async () => {
        // The event is scoped, and this is checked anyway: the cost of being wrong is one
        // organization's code on another's hostname, which is not a thing to find in a log later.
        const world = fakeContext({
            releases: [release({ tenantId: 'org-2' } as Partial<Release>)],
            composedHash: 'sha256:new',
        });

        await rollForPart(world.ctx as never, RELEASED);

        expect(world.called('cdn.compose')).toHaveLength(0);
    });

    it('does not deploy a composition that no longer holds together', async () => {
        const world = fakeContext({
            releases: [release()],
            composedHash: '',
            problems: [{ kind: 'missing_part', message: 'chrome@0.2.5 has no artifact' }],
            sites: [{ id: 's1', host: 'console.surfdns.net' }],
        });

        await rollForPart(world.ctx as never, RELEASED);

        expect(world.called('cdn.deploy')).toHaveLength(0);
        expect(world.called('release.update')).toHaveLength(0);
    });

    it('keeps rolling when one site refuses the new release', async () => {
        /**
         * `cdn.deploy` refuses a release calling a contract the site does not expose, and a rolled
         * release can acquire one. That refusal is the grant check working at the right moment — it
         * must leave that site where it is, and must not stop the roll.
         */
        const world = fakeContext({
            releases: [release()],
            composedHash: 'sha256:new',
            sites: [{ id: 's1', host: 'console.surfdns.net' }],
            deployThrows: 'console.surfdns.net does not expose node.provision',
        });

        await rollForPart(world.ctx as never, RELEASED);

        expect(world.called('release.update')[0]?.params['supersededBy']).toBe('sha256:new');
        expect(world.emitted[0]?.tool).toBe('cdn.release_rolled');
    });
});
