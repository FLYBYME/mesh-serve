import { describe, expect, it } from 'vitest';
import { membershipAssignContract, membershipCrud } from '../../../src/identity/contracts/membership.contract.js';

/**
 * People come and go through identity.membership.assign, which keeps an owner and lets only an
 * owner touch the owner role. The raw writes are an operator's: the raw delete was an admin's, and
 * an admin took the owner out of their organization with it (review 10-26).
 */
describe('identity.membership writes', () => {
    it('every raw write needs an operator', () => {
        const writes: ReadonlyArray<'create' | 'update' | 'delete'> = ['create', 'update', 'delete'];
        for (const action of writes) {
            expect(membershipCrud[action].permissions).toEqual(['operator']);
        }
    });

    it('an admin manages people through assign', () => {
        expect(membershipAssignContract.permissions).toEqual(['admin']);
    });
});
