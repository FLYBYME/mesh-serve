/**
 * A site's route table.
 *
 * This is what replaced mesh-api's `mountRest`, and the reason is here rather than in style: that
 * function built a fixed route table **at boot** from a list of live contract objects. Which routes
 * exist now depends on which hostname asked — one site may expose a contract as `public` while
 * another requires `user`, on one release — so the table is derived from the record and cached with
 * it.
 *
 * Everything tested below fails *silently* if it is wrong: a shadowed route answers the wrong
 * contract, a duplicated key takes the weaker of two gates, and an exposure hash that moves with the
 * order somebody typed a list makes every client think the API changed.
 */

import { defineContract, z } from '@flybyme/mesh';
import { describe, expect, it } from 'vitest';

import { digestOf, canonical } from '../../src/builder/methods/content.js';
import { matchRoute, routeTable, type ContractLookup } from '../../src/api/methods/routes.js';
import type { MeshDependency } from '../../src/cdn/schema/site.js';

const hash = (value: unknown): string => digestOf(canonical(value));

const contract = (domain: string, action: string, method: 'GET' | 'POST', path: string) =>
    defineContract({
        domain, action, description: `${domain} ${action}`,
        inputSchema: z.object({}), outputSchema: z.object({}),
        rest: { method, path },
        print: () => '',
    });

const registry = new Map<string, ReturnType<typeof contract>>([
    ['domains.zone_find', contract('domains', 'zone_find', 'GET', '/zones')],
    ['domains.zone_get', contract('domains', 'zone_get', 'GET', '/zones/:id')],
    ['domains.zone_mine', contract('domains', 'zone_mine', 'GET', '/zones/mine')],
    ['domains.zone_create', contract('domains', 'zone_create', 'POST', '/zones')],
    ['domains.clash', contract('domains', 'clash', 'GET', '/zones')],
]);

const lookup: ContractLookup = (key) => registry.get(key);

const mesh = (...contracts: { key: string; auth?: 'public' | 'user' | 'admin'; permission?: string }[]):
readonly MeshDependency[] => [{
    package: '@flybyme/surfdns-domains',
    version: '^2.1',
    contracts: contracts.map((c) => (c.permission === undefined
        ? { key: c.key, auth: c.auth ?? 'user' }
        : { key: c.key, permission: c.permission })) as MeshDependency['contracts'],
    // Routing is about contracts. Events are exposed separately and resolved in a different
    // registry — see the site schema for why they are not one list.
    events: [],
}];

describe('building a table', () => {
    it('takes the gate from the site, never from the contract', () => {
        // A part declares what it *calls*; a site declares what it *exposes and at what level*. A
        // part that could choose its own gate would make installing one a privilege escalation.
        const table = routeTable(mesh({ key: 'domains.zone_find', auth: 'public' }), lookup, hash);

        expect(table.routes[0]?.gate).toEqual({ kind: 'auth', level: 'public' });
    });

    it('carries a named permission through', () => {
        const table = routeTable(
            mesh({ key: 'domains.zone_create', permission: 'domains.write' }), lookup, hash,
        );

        expect(table.routes[0]?.gate).toEqual({ kind: 'permission', permission: 'domains.write' });
    });

    it('takes method and path from the contract, not from the site', () => {
        // Where a contract answers is the contract author's business. A site that could move a route
        // would be a site whose generated client is wrong for every other site.
        const table = routeTable(mesh({ key: 'domains.zone_get' }), lookup, hash);

        expect(table.routes[0]).toMatchObject({ method: 'GET', path: '/zones/:id' });
    });
});

describe('what it refuses, and what it merely reports', () => {
    it('reports a contract nothing provides, and still serves the rest', () => {
        // A typo in one line taking a whole site off the internet is a worse failure than the typo.
        const table = routeTable(
            mesh({ key: 'domains.zone_find' }, { key: 'domains.nonexistent' }), lookup, hash,
        );

        expect(table.routes).toHaveLength(1);
        expect(table.unknown).toEqual(['domains.nonexistent']);
    });

    it('refuses the second of two contracts claiming one route, and names both', () => {
        // Otherwise the site answers one of them by accident of declaration order, and which one
        // depends on how the record was written.
        const table = routeTable(
            mesh({ key: 'domains.zone_find' }, { key: 'domains.clash' }), lookup, hash,
        );

        expect(table.routes).toHaveLength(1);
        expect(table.unknown[0]).toContain('domains.clash');
        expect(table.unknown[0]).toContain('domains.zone_find');
    });

    it('keeps the first of a duplicated key, so a second gate cannot weaken the first', () => {
        const table = routeTable(
            mesh({ key: 'domains.zone_find', auth: 'admin' },
                { key: 'domains.zone_find', auth: 'public' }), lookup, hash,
        );

        expect(table.routes).toHaveLength(1);
        expect(table.routes[0]?.gate).toEqual({ kind: 'auth', level: 'admin' });
    });
});

describe('the exposure hash', () => {
    it('does not move when the list is reordered', () => {
        // Reordering a record must not look to a client like the API changed.
        const one = routeTable(mesh({ key: 'domains.zone_find' }, { key: 'domains.zone_get' }), lookup, hash);
        const other = routeTable(mesh({ key: 'domains.zone_get' }, { key: 'domains.zone_find' }), lookup, hash);

        expect(other.exposure).toBe(one.exposure);
    });

    it('moves when a gate changes', () => {
        // A client generated against `public` and pointed at an API serving `user` is a lie the
        // compiler vouches for.
        const open = routeTable(mesh({ key: 'domains.zone_find', auth: 'public' }), lookup, hash);
        const closed = routeTable(mesh({ key: 'domains.zone_find', auth: 'user' }), lookup, hash);

        expect(closed.exposure).not.toBe(open.exposure);
    });

    it('moves when a contract is added or removed', () => {
        const one = routeTable(mesh({ key: 'domains.zone_find' }), lookup, hash);
        const two = routeTable(mesh({ key: 'domains.zone_find' }, { key: 'domains.zone_get' }), lookup, hash);

        expect(two.exposure).not.toBe(one.exposure);
    });
});

describe('matching a request', () => {
    const table = routeTable(
        mesh(
            { key: 'domains.zone_find' }, { key: 'domains.zone_get' },
            { key: 'domains.zone_mine' }, { key: 'domains.zone_create' },
        ),
        lookup, hash,
    );

    it('matches a literal path', () => {
        expect(matchRoute(table, 'GET', '/zones')?.route.key).toBe('domains.zone_find');
    });

    it('extracts a parameter', () => {
        const found = matchRoute(table, 'GET', '/zones/abc123');
        expect(found?.route.key).toBe('domains.zone_get');
        expect(found?.params).toEqual({ id: 'abc123' });
    });

    it('prefers the literal route over the parameterised one', () => {
        // `/zones/mine` must beat `/zones/:id` however the site happened to order them — otherwise a
        // specific route is shadowed by a general one by accident of declaration order.
        expect(matchRoute(table, 'GET', '/zones/mine')?.route.key).toBe('domains.zone_mine');
    });

    it('separates methods on one path', () => {
        expect(matchRoute(table, 'POST', '/zones')?.route.key).toBe('domains.zone_create');
        expect(matchRoute(table, 'GET', '/zones')?.route.key).toBe('domains.zone_find');
    });

    it('does not match a different depth', () => {
        expect(matchRoute(table, 'GET', '/zones/a/b')).toBeUndefined();
        expect(matchRoute(table, 'GET', '/')).toBeUndefined();
    });

    it('decodes a parameter', () => {
        expect(matchRoute(table, 'GET', '/zones/a%20b')?.params).toEqual({ id: 'a b' });
    });

    it('has nothing for a method nobody exposed', () => {
        expect(matchRoute(table, 'DELETE', '/zones')).toBeUndefined();
    });
});

describe('filtering by release requirements', () => {
    it('only routes contracts required by the release', () => {
        const t = routeTable(
            mesh({ key: 'domains.zone_find' }, { key: 'domains.zone_create' }),
            lookup,
            hash,
            ['domains.zone_find'],
        );

        expect(t.routes).toHaveLength(1);
        expect(t.routes[0]?.key).toBe('domains.zone_find');
    });

    it('routes nothing if release requires no contracts', () => {
        const t = routeTable(
            mesh({ key: 'domains.zone_find' }, { key: 'domains.zone_create' }),
            lookup,
            hash,
            [],
        );

        expect(t.routes).toHaveLength(0);
    });
});

