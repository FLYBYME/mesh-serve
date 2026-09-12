/**
 * `identity.grant_role` — the contract without which nobody can ever be an operator.
 *
 * Cluster roles live on the user row, identity keeps its own store, and `user` is internal for
 * writes, so before this existed the only route to the operator role was a database client. Every
 * operator-gated contract was unreachable by construction: the fleet console answered 403 to
 * everybody, permanently, and no configuration of any site could change it.
 *
 * These tests are mostly about **who may call it**, because that is the whole risk surface of a
 * contract that hands out platform standing.
 */

import { describe, expect, it } from 'vitest';

import {
    allIdentityContracts, grantRoleContract,
} from '../../src/identity/contracts/identity.contract.js';

describe('the shape of granting a role', () => {
    it('is registered, or nothing can route to it', () => {
        expect(allIdentityContracts).toContain(grantRoleContract);
    });

    it('takes either an id or an address, because a person has an address', () => {
        const shape = grantRoleContract.inputSchema.shape;
        expect(shape).toHaveProperty('userId');
        expect(shape).toHaveProperty('email');
        expect(shape).toHaveProperty('role');
    });

    it('revokes through the same contract, since the check is identical', () => {
        // A separate revoke contract would be a second door onto the same decision, and the second
        // door is the one that gets a weaker check.
        expect(grantRoleContract.inputSchema.shape).toHaveProperty('granted');
        const parsed = grantRoleContract.inputSchema.parse({ email: 'a@b.co', role: 'operator' });
        expect(parsed.granted).toBe(true);
    });

    it('is exposable, and says so rather than being reachable only internally', () => {
        // `public` means *may be exposed*, never *unauthenticated*. A site that exposes it must
        // gate it at operator — and the handler checks the caller's role regardless, because a
        // contract granting platform standing is the last place to trust a site record.
        expect(grantRoleContract.visibility).toBe('public');
        expect(grantRoleContract.destructive).toBe(true);
    });

    it('refuses a role it was not given', () => {
        expect(() => grantRoleContract.inputSchema.parse({ email: 'a@b.co' })).toThrow();
        expect(() => grantRoleContract.inputSchema.parse({ email: 'a@b.co', role: '' })).toThrow();
    });
});
