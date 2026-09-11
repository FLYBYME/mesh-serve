/**
 * **What gate a contract goes behind on a seeded site, when nobody has said otherwise.**
 *
 * `gateFor` is the site owner's policy written once rather than typed out per contract, and it ends
 * in `return 'operator'` — the right instinct for *I do not know what this does*, because a
 * too-strict gate is a 403 somebody reports and a too-loose one is not noticed.
 *
 * These pin the exceptions, which are the part that gets edited. Each one is a contract where the
 * default is not merely strict but wrong.
 */

import { describe, expect, it } from 'vitest';

import { gateFor, ALWAYS_GRANTED, grantsFor } from '../../src/cdn/methods/grants.js';

describe('gateFor', () => {
    it('opens only what a signed-out browser must reach to sign in at all', () => {
        expect(gateFor('identity.register')).toBe('public');
        expect(gateFor('identity.ticket_issue')).toBe('public');
        expect(gateFor('telem.ingest')).toBe('public');
    });

    /**
     * **F28.** A password change is a write, matches none of the read patterns, and fell to the
     * default — so on every seeded site a person was refused their own password. `set_password`
     * takes no subject id on purpose: the caller *is* the subject, which the contract states above
     * its own visibility. Found on the live two-tenant cluster, where flowboard's owner got 403 on
     * their own site.
     */
    it('lets a signed-in person change their own password', () => {
        expect(gateFor('identity.set_password')).toBe('user');
    });

    it('keeps a session\'s own reads and its sign-out at user', () => {
        expect(gateFor('identity.whoami')).toBe('user');
        expect(gateFor('identity.sign_out')).toBe('user');
        expect(gateFor('identity.ticket_revoke')).toBe('user');
    });

    /**
     * The fleet answers operators including its reads, because that is what its handlers demand. A
     * gate looser than the handler is a promise the platform will not keep — the failure this line
     * exists to prevent (`node.status` let through the gate and refused inside).
     */
    it('gives the whole fleet to operators, reads included', () => {
        expect(gateFor('node.status')).toBe('operator');
        expect(gateFor('node.assign')).toBe('operator');
        expect(gateFor('group.find')).toBe('operator');
    });

    it('gives a generated read to any signed-in caller', () => {
        expect(gateFor('card.find')).toBe('user');
        expect(gateFor('site.get')).toBe('user');
        expect(gateFor('release.count')).toBe('user');
        expect(gateFor('project.find_one')).toBe('user');
    });

    /**
     * **The default, and the thing to keep looking at.** Every write a table has not been taught
     * about is an operator's, which is right for `cdn.deploy` and is the reason a tenant cannot
     * write to its own application — roadmap F27.
     */
    it('refuses everything else to anyone but an operator', () => {
        expect(gateFor('cdn.deploy')).toBe('operator');
        expect(gateFor('site.seed')).toBe('operator');
        expect(gateFor('card.create')).toBe('operator');
        expect(gateFor('card.update')).toBe('operator');
        expect(gateFor('anything.nobody.classified')).toBe('operator');
    });
});

describe('grantsFor', () => {
    it('grants sign-in and telemetry whether a part asked or not', () => {
        const { contracts } = grantsFor([]);
        expect(contracts.map((c) => c.key).sort()).toEqual([...ALWAYS_GRANTED].sort());
    });

    /**
     * An agent role is by definition held by somebody who is not an operator, so a write a role
     * names is lowered to `user` — otherwise the role map is decorative. It never goes below what
     * `gateFor` decided, so a `public` stays public and nothing is loosened past a read.
     */
    it('lowers an operator guess to user for a contract a role names, and no further', () => {
        const { contracts } = grantsFor(['card.create', 'card.find'], { planner: ['card.create', 'card.find'] });
        const gate = Object.fromEntries(contracts.map((c) => [c.key, 'auth' in c ? c.auth : `permission:${c.permission}`]));

        expect(gate['card.create']).toBe('user');
        expect(gate['card.find']).toBe('user');
        expect(gate['identity.register']).toBe('public');
    });

    /**
     * **F30 stage 3 changed this test's second assertion, and the change is the point.**
     *
     * `card.update` used to be `operator`, which meant the account that owned the organization the
     * application belonged to could not move a card on its own board. It is now a permission named
     * after the contract, answered by the grants seeding installed. A contract nobody granted is
     * still refused — `permits` denies by default — so this is not a loosening, it is the same
     * refusal asked of the right thing.
     */
    it('turns an operator fall-through in somebody else\'s domain into a permission', () => {
        const { contracts } = grantsFor(['card.create', 'card.update'], { planner: ['card.create'] });
        const gate = Object.fromEntries(contracts.map((c) => [c.key, 'auth' in c ? c.auth : `permission:${c.permission}`]));

        // Named by a role, so the branch above this one already lowered it.
        expect(gate['card.create']).toBe('user');
        expect(gate['card.update']).toBe('permission:card.update');
    });

    it('leaves this repository\'s own domains at operator, however they were exposed', () => {
        // The half that must not move. `gateFor`'s default is right for the contracts it was
        // written against, and a part naming one in its manifest does not make it the part's.
        const { contracts } = grantsFor(['cdn.deploy', 'site.create', 'node.assign', 'builder.release_repo']);
        const gate = Object.fromEntries(contracts.map((c) => [c.key, 'auth' in c ? c.auth : `permission:${c.permission}`]));

        expect(gate['cdn.deploy']).toBe('operator');
        expect(gate['site.create']).toBe('operator');
        expect(gate['node.assign']).toBe('operator');
        expect(gate['builder.release_repo']).toBe('operator');
    });

    it('leaves a read alone, because only the fall-through moves', () => {
        // Reads become permissions too eventually; that is a larger change and is on F30. Smuggling
        // it in here would mean this commit changed who can read as well as who can write.
        const { contracts } = grantsFor(['card.find', 'card.get', 'project.git_info']);
        const gate = Object.fromEntries(contracts.map((c) => [c.key, 'auth' in c ? c.auth : `permission:${c.permission}`]));

        expect(gate['card.find']).toBe('user');
        expect(gate['card.get']).toBe('user');
        // Not a read by the suffix rule, so it falls through — and it is flowboard's domain.
        expect(gate['project.git_info']).toBe('permission:project.git_info');
    });

    /** A collection streams at exactly its own `find`'s gate — looser would push rows to somebody
     *  who may not read them. */
    it('streams a collection at its find\'s gate', () => {
        const { events } = grantsFor(['card.find']);
        expect(events).toEqual([
            { key: 'card.created', auth: 'user' },
            { key: 'card.updated', auth: 'user' },
            { key: 'card.deleted', auth: 'user' },
        ]);
    });
});
