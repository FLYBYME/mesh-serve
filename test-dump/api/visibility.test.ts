/**
 * **What `visibility` protects, and what it does not.**
 *
 * `defineCrud` takes a per-action `visibility`, and `user` marks every action `internal` on purpose,
 * with a comment saying so. The question these tests answer is what that word buys.
 *
 * The honest answer is *one boundary out of two*:
 *
 * | a call arriving | is `visibility` checked? |
 * | --- | --- |
 * | over HTTP, on a site's exposure | **yes** — `describeExposure` refuses to route it |
 * | over the mesh, from any joined peer | **no** — nothing consults it at dispatch |
 *
 * Found by `src/bring-up.ts`, which calls `user.find_one` with **no meta at all** — no ticket, no
 * organization, no roles — and reads whatever it likes.
 *
 * ## Why the second group uses `it.fails`
 *
 * Because asserting the broken behaviour would encode the bug as intent, and this repository has
 * done that four separate times. `it.fails` asserts the behaviour that *should* hold and passes only
 * while it does not — so the suite goes red the day somebody fixes D6, which is the moment to delete
 * the marker rather than a moment to discover a test was lying.
 *
 * @see spec/roadmap.md D6, D7
 */

import { defineCrud, z } from '@flybyme/mesh';
import { describe, expect, it } from 'vitest';

import { releaseCrud } from '../../src/cdn/contracts/release.contract.js';
import { siteCrud } from '../../src/cdn/contracts/site.contract.js';
import { partCrud, partVersionCrud } from '../../src/catalog/contracts/part.contract.js';
import { artifactCrud, buildCrud } from '../../src/builder/contracts/artifact.contract.js';
import { membershipCrud, roleCrud } from '../../src/identity/contracts/identity.contract.js';
import { describeExposure } from '../../src/api/schema/descriptor.js';

// ---------------------------------------------------------------------------- the boundary that works

const internalCrud = defineCrud('secret', z.object({ email: z.string() }), {
    pluralPath: 'secrets',
    // Nothing named, which is the whole point: anything not listed stays internal.
    dependencies: [],
});

describe('visibility at the HTTP boundary', () => {
    it('refuses to put an internal contract on a site', () => {
        // The one place in the repository that reads `visibility`, and it does its job: an internal
        // contract cannot be given a gate and routed, whatever gate is asked for.
        expect(() => describeExposure(
            [{ contract: internalCrud.find, auth: 'user' }],
            { application: 'test' },
        )).toThrow(/internal/i);
    });

    it('allows one that declares itself public', () => {
        // The control. Without it the test above passes for any reason at all — a typo in the
        // contract, a thrown error from somewhere else in `describeExposure`.
        expect(() => describeExposure(
            [{ contract: siteCrud.find, auth: 'user' }],
            { application: 'test' },
        )).not.toThrow();
    });
});

// ---------------------------------------------------------------------------- the boundary that does not

describe('visibility at the mesh boundary', () => {
    /**
     * **D6.** Nothing consults `visibility` at dispatch — not `ServiceBroker`, not `ServiceModule`,
     * not any middleware. The only readers in the whole repository are `describeExposure` above and
     * a log line, so `internal` is a statement about routing rather than about reachability.
     *
     * Asserted against the contract objects rather than a live cluster, because the claim is about
     * *where the word is read*, and a cluster test would prove the same thing more slowly and with
     * a mongo dependency.
     */
    it.fails('marks internal actions in a way the dispatcher can act on', () => {
        // A dispatcher would need this to be reachable per action at call time. It is: the metadata
        // is right there on the contract. What is missing is anybody reading it — so this asserts
        // the thing that would have to be true *and used*, and fails until D6 wires it up.
        const enforced = (internalCrud.find as { enforcedAtDispatch?: boolean }).enforcedAtDispatch;
        expect(enforced).toBe(true);
    });
});

// ---------------------------------------------------------------------------- what is exposed, and on what argument

/**
 * **Every publicly-readable collection is either scoped or deliberately global.**
 *
 * This is the invariant that `release` breaks, and it is worth testing as an invariant rather than
 * as a fact about one collection: the failure mode is a *new* collection being exposed by somebody
 * reading the reassuring comment on the one next to it.
 *
 * The three global ones are listed by name and each has a reason recorded on the collection itself:
 * an artifact is content-addressed so two organizations building identical source produced the same
 * artifact; a part name is one flat public namespace because a catalog is a marketplace.
 */
const DELIBERATELY_GLOBAL = new Set(['artifact', 'part', 'partVersion', 'role']);

const readsPublicly = (crud: { visibility?: Record<string, string> }): boolean =>
    crud.visibility?.['find'] === 'public';

describe('a publicly readable collection is scoped or deliberately global', () => {
    it('site is scoped', () => {
        expect(siteCrud.scopedBy).toBe('tenantId');
    });

    it('membership is scoped', () => {
        expect(membershipCrud.scopedBy).toBe('organizationId');
    });

    it('the global ones say so on purpose', () => {
        for (const crud of [artifactCrud, partCrud, partVersionCrud, roleCrud]) {
            expect(DELIBERATELY_GLOBAL.has(crud.domain)).toBe(true);
        }
    });

    /**
     * **D7.** `releaseCrud` exposes `find`, `find_one`, `get` and `count` as `public`, and its own
     * comment says that is safe *because* `scopedBy` narrows every read to the caller's
     * organization. It declares no `scopedBy`, and the framework has no default — so this returns
     * every composition on the platform: which parts each tenant runs, at which versions, at which
     * digests.
     *
     * `it.fails` rather than an assertion of the current state, for the reason at the top of the
     * file. Deleting the marker is part of fixing it.
     */
    it.fails('release is scoped, as its own comment claims', () => {
        expect(readsPublicly(releaseCrud as never)).toBe(true);
        expect(releaseCrud.scopedBy).toBe('tenantId');
    });

    it('build is not publicly readable, since nothing decided it should be', () => {
        // Unscoped *and* unexposed is fine. Unscoped and exposed is D7. This is the assertion that
        // catches somebody exposing it without making the scoping decision first.
        expect(readsPublicly(buildCrud as never)).toBe(false);
    });
});
