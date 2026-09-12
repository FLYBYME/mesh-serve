/**
 * The narrowing hook, and the reason it lives on its own module.
 *
 * **This is the test that would have caught the bug.** `mountCrudHook('membership', …)` on a service
 * whose `domain` is `identity` registers happily and is never called: mesh looks up the module by
 * `getModule(domain)`, matching the *collection's* domain. The hook was dead code that looked alive,
 * and a narrowing hook that does not narrow returns every row in the collection.
 */

import { describe, expect, it } from 'vitest';

import type { IServiceContext } from '@flybyme/mesh';

import { CollectionService, ownRowsOnly } from '../src/collection.js';
import { membershipCrud, userCrud } from '../src/identity/contracts/identity.contract.js';
import { collectionServices } from '../src/collections.js';

const asCaller = (id: string | undefined): IServiceContext =>
    ({ meta: id === undefined ? {} : { user: { id, tenant_id: '' } } }) as unknown as IServiceContext;

describe('ownRowsOnly', () => {
    const narrow = ownRowsOnly('userId');

    it('adds the caller to a query that had none', async () => {
        const out = await narrow({ limit: 10 }, asCaller('u1'));
        expect(out).toEqual({ limit: 10, query: { userId: 'u1' } });
    });

    /**
     * **Applied last and overwriting.** A query that already names the field is a caller asking
     * about somebody else, and the answer to that is their own rows — not a merge that honours
     * whichever key was written second.
     */
    it('overwrites a query naming somebody else', async () => {
        const out = await narrow({ query: { userId: 'somebody-else' } }, asCaller('u1'));
        expect(out).toEqual({ query: { userId: 'u1' } });
    });

    it('keeps the rest of the query', async () => {
        const out = await narrow({ query: { roleKey: 'operator' } }, asCaller('u1'));
        expect(out).toEqual({ query: { roleKey: 'operator', userId: 'u1' } });
    });

    /**
     * **Nothing, not everything.** The failure mode of a narrowing hook is that it quietly does not
     * narrow, so a caller with no identity has to match no rows by construction rather than by a
     * check somebody remembers to write.
     */
    it('matches nothing when there is no caller', async () => {
        const out = await narrow({}, asCaller(undefined));
        expect(out).toEqual({ query: { userId: '' } });
    });

    it('survives a non-object input rather than throwing on the security path', async () => {
        expect(await narrow(undefined, asCaller('u1'))).toEqual({ query: { userId: 'u1' } });
    });
});

describe('a collection is its own module', () => {
    /**
     * The property the bug violated. mesh finds a hook by `getModule(collectionDomain)`, so this has
     * to hold or the hook is never asked for.
     */
    it('takes its domain from the collection, not from the service that owns the behaviour', () => {
        expect(new CollectionService(membershipCrud).domain).toBe('membership');
        expect(new CollectionService(userCrud).domain).toBe('user');
    });

    it('registers every collection this package serves, each under its own domain', () => {
        const domains = collectionServices().map((s) => s.domain).sort();
        expect(domains).toEqual(['membership', 'organization', 'site', 'ticket', 'user']);
    });

    /**
     * `find_one` and `count` are narrowed alongside `find`. A narrowing applied to the obvious read
     * and not its two siblings is the shape that gets found by somebody enumerating with `count`.
     */
    it('narrows every read on membership, not just find', async () => {
        const membership = collectionServices().find((s) => s.domain === 'membership');
        expect(membership).toBeDefined();

        for (const action of ['find', 'find_one', 'count']) {
            const narrowed = await membership?.beforeCrud('membership', action, {}, asCaller('u1'));
            expect(narrowed, `${action} must be narrowed`).toEqual({ query: { userId: 'u1' } });
        }
    });

    it('leaves a collection with no hooks alone', async () => {
        const organization = collectionServices().find((s) => s.domain === 'organization');
        const untouched = await organization?.beforeCrud('organization', 'find', { limit: 3 }, asCaller('u1'));
        expect(untouched).toEqual({ limit: 3 });
    });
});
