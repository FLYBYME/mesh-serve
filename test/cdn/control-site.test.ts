/**
 * **The control site: what a node serves for itself.**
 *
 * A cluster with no sites cannot be reached — the api dispatches by `Host` → site, so on a fresh node
 * `identity.ticket_issue` is mounted and pointed at by nothing. Every way around that went *outside*
 * the api: `bring-up` joins the mesh as a peer, `npx mesh --bootstrap` does it by hand, and both land
 * on roadmap D6, where a joined peer may assert any identity it likes.
 *
 * What this file protects is the list itself, because the way it fails is not a wrong answer — it is
 * a 500 on the whole site.
 */

import { describe, expect, it } from 'vitest';

import { CONTROL_CONTRACTS, DEFAULT_CONTROL_HOST, PLATFORM_SLUG } from '../../src/cdn/methods/control.js';
import { describeExposure } from '../../src/api/schema/descriptor.js';
import { globalContractRegistry } from '@flybyme/mesh';

// Importing a service mounts its contracts into the registry, which is where `lookup` reads them.
import '../../src/identity/index.js';
import '../../src/catalog/catalog.service.js';
import '../../src/builder/builder.service.js';
import '../../src/cdn/cdn.service.js';
import '../../src/fleet/fleet.service.js';

describe('the control contract list', () => {
    /**
     * **The failure this exists for.**
     *
     * `describeExposure` throws on a contract its own domain marks `internal` — deliberately, since
     * exposing one publishes an implementation detail to the internet. But a site's descriptor is
     * built lazily on request, so the throw arrives as a **500 on `/_describe`**, which takes down
     * the whole site rather than the one entry. That is not hypothetical: granting
     * `identity.ticket_revoke` did exactly this on 2026-09-08 and the message named the contract
     * while the symptom was a blank page.
     *
     * A list that cannot be exposed is therefore a broken node, not a missing tool, and it must fail
     * here instead.
     */
    it('names only contracts that may actually be exposed', () => {
        const entries = CONTROL_CONTRACTS.map((exposed) => {
            const contract = globalContractRegistry.get(exposed.key);
            expect(contract, `${exposed.key} is in CONTROL_CONTRACTS but nothing provides it`).toBeDefined();
            return { contract: contract as never, auth: exposed.auth };
        });

        expect(() => describeExposure(entries, { application: 'control', base: '/api' })).not.toThrow();
    });

    /**
     * Signing in and claiming a provisional account are what somebody with **no session** does, so
     * they cannot need one. `set_password` takes no `userId` — the caller *is* the subject — which is
     * what makes `public` safe here rather than merely convenient.
     */
    it('lets an unauthenticated caller sign in and claim an account, and nothing else', () => {
        const open = CONTROL_CONTRACTS.filter((c) => c.auth === 'public').map((c) => c.key).sort();
        expect(open).toEqual(['identity.set_password', 'identity.ticket_issue']);
    });

    /**
     * **`identity.register` is deliberately absent.**
     *
     * On a tenant site it is how people join. On the platform's own control surface it would be a
     * way to mint an account on a machine you have not signed in to — and the first-boot operator
     * already exists, so there is nothing it would enable that is not already possible for somebody
     * holding the password printed at boot.
     */
    it('offers no way to create an account', () => {
        expect(CONTROL_CONTRACTS.map((c) => c.key)).not.toContain('identity.register');
    });

    /** Everything that changes what the platform runs is an operator's, without exception. */
    it('gates every management contract at operator', () => {
        const weak = CONTROL_CONTRACTS
            .filter((c) => c.auth !== 'operator')
            .map((c) => `${c.key}@${c.auth}`)
            .sort();

        // The four that are not operator are the session ones, and they are named rather than
        // counted so that adding a fifth has to be a decision somebody writes down.
        expect(weak).toEqual([
            'identity.set_password@public',
            'identity.sign_out@user',
            'identity.ticket_issue@public',
            'identity.whoami@user',
        ]);
    });

    it('answers where a node has no name yet', () => {
        expect(DEFAULT_CONTROL_HOST).toBe('127.0.0.1');
        expect(PLATFORM_SLUG).toBe('platform');
    });

    /** Two entries for one contract means two gates, and the weaker one wins by ordering. */
    it('names each contract once', () => {
        const keys = CONTROL_CONTRACTS.map((c) => c.key);
        expect(keys.length).toBe(new Set(keys).size);
    });
});
