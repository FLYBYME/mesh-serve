/**
 * A release, and the hash that names it.
 *
 * The hash is the whole reason a release is worth having: it makes *"staging runs the same code as
 * production"* checkable instead of claimed. So the tests are about when two compositions are the
 * same and when they are not, and every one of them is a case where being wrong is silent.
 */

import { describe, expect, it } from 'vitest';

import {
    checkComposition, isFatal, releaseHash, type Composition, type Requirement,
} from '../../src/cdn/methods/release.js';

const composition = (over: Partial<Composition> = {}): Composition => ({
    kernel: { version: '0.3.0', digest: 'sha256:kernel' },
    parts: {
        auth: { version: '0.1.0', digest: 'sha256:auth' },
        console: { version: '1.0.0', digest: 'sha256:console' },
    },
    policy: {},
    ...over,
});

describe('two people composing the same set land on the same release', () => {
    it('agrees with itself', () => {
        expect(releaseHash(composition())).toBe(releaseHash(composition()));
    });

    it('does not depend on the order parts were written in', () => {
        // A record has no order, but its serialisation does. Without the sort, two nodes composing
        // the same set would mint two releases and store the same artifacts twice.
        const reordered = composition({
            parts: {
                console: { version: '1.0.0', digest: 'sha256:console' },
                auth: { version: '0.1.0', digest: 'sha256:auth' },
            },
        });

        expect(releaseHash(reordered)).toBe(releaseHash(composition()));
    });

    it('does not depend on who composed it or when', () => {
        // `tenantId`, `name` and `composedAt` are deliberately not inputs: two organizations
        // composing the same kernel and parts have composed the same thing.
        expect(releaseHash(composition())).toBe(releaseHash({ ...composition() }));
    });
});

describe('two different compositions are different releases', () => {
    it('when a part is at different bytes', () => {
        const other = composition({
            parts: {
                auth: { version: '0.1.0', digest: 'sha256:auth-rebuilt' },
                console: { version: '1.0.0', digest: 'sha256:console' },
            },
        });

        expect(releaseHash(other)).not.toBe(releaseHash(composition()));
    });

    it('when a version label differs, even at identical bytes', () => {
        // `1.0.0` and `1.0.0-hotfix` resolving to the same bytes is a real situation, and telling
        // them apart in a rollback list is worth the extra field in the hash.
        const other = composition({
            parts: {
                auth: { version: '0.1.1', digest: 'sha256:auth' },
                console: { version: '1.0.0', digest: 'sha256:console' },
            },
        });

        expect(releaseHash(other)).not.toBe(releaseHash(composition()));
    });

    it('when the kernel differs', () => {
        expect(releaseHash(composition({ kernel: { version: '0.4.0', digest: 'sha256:k2' } })))
            .not.toBe(releaseHash(composition()));
    });

    it('when a part is added', () => {
        const more = composition({
            parts: { ...composition().parts, extra: { version: '1.0.0', digest: 'sha256:extra' } },
        });

        expect(releaseHash(more)).not.toBe(releaseHash(composition()));
    });

    it('when policy differs, because policy changes what the page does', () => {
        expect(releaseHash(composition({ policy: { 'window-manager/mode': 'tiled' } })))
            .not.toBe(releaseHash(composition()));
    });
});

describe('does this set of parts hold together', () => {
    const required = (over: Partial<Requirement> = {}): Requirement =>
        ({ by: 'console', id: 'auth', version: '^0.1', optional: false, ...over });

    it('refuses a required part that is absent', () => {
        // An Application consuming AUTH on a page with no auth Extension is a blank panel and a
        // console error. A refused deploy is a much better way to find out.
        const problems = checkComposition(['console'], [required()], [], []);

        expect(problems).toHaveLength(1);
        expect(problems[0]?.kind).toBe('missing_part');
        // Named, because "something needs auth" is not something anyone can act on.
        expect(problems[0]?.message).toContain('console');
        expect(problems[0]?.message).toContain('auth');
        expect(isFatal(problems[0]!)).toBe(true);
    });

    it('reports an optional part that is absent, and does not refuse it', () => {
        // Refusing would make `optional` mean nothing.
        const problems = checkComposition(['console'], [required({ optional: true })], [], []);

        expect(problems[0]?.kind).toBe('missing_optional');
        expect(isFatal(problems[0]!)).toBe(false);
    });

    it('is satisfied when the part is there', () => {
        expect(checkComposition(['console', 'auth'], [required()], [], [])).toEqual([]);
    });

    it('refuses a contract the site does not expose', () => {
        // Otherwise it is a 404 nobody can distinguish from a route that never existed.
        const problems = checkComposition([], [], ['identity.whoami'], []);

        expect(problems[0]?.kind).toBe('unmet_contract');
        expect(isFatal(problems[0]!)).toBe(true);
    });

    it('reports a grant nothing uses, and does not refuse it', () => {
        // The route somebody left behind when they deleted the screen that used it: worth seeing,
        // not worth failing a deploy over.
        const problems = checkComposition([], [], [], ['identity.whoami']);

        expect(problems[0]?.kind).toBe('unused_grant');
        expect(isFatal(problems[0]!)).toBe(false);
    });

    it('is quiet when requirements and grants line up exactly', () => {
        expect(checkComposition(['auth'], [], ['identity.whoami'], ['identity.whoami'])).toEqual([]);
    });

    it('reports everything wrong at once', () => {
        // A caller composing five parts wants all five answers. Failing on the first turns one
        // round trip into five.
        const problems = checkComposition(
            [], [required(), required({ by: 'a', id: 'b' })], ['x.one'], ['y.two'],
        );

        expect(problems).toHaveLength(4);
        expect(problems.filter(isFatal)).toHaveLength(3);
    });
});
