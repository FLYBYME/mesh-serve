/**
 * Routing, precedence, and the query string.
 *
 * All pure. A route table is built from a description and matched against a method and a path, with
 * no server in the way.
 */

import { describe, expect, it } from 'vitest';

import { z } from '@flybyme/mesh';

import {
    decodeQuery, decodeQueryValue, matchRoute, mergeInput, routeTable,
} from '../src/serve/methods/routes.js';
import type { DescribedCall } from '../src/serve/methods/descriptor.js';

const call = (key: string, method: string, path: string): DescribedCall => ({
    key,
    domain: key.split('.')[0] ?? '',
    action: key.split('.')[1] ?? '',
    description: '',
    method,
    path,
    gate: 'user',
    input: z.object({}),
    output: z.object({}),
    destructive: false,
    errors: [],
});

describe('the route table', () => {
    /**
     * The reason the table is sorted at all. `/sites/count` and `/sites/:id` both match one segment
     * after `/sites`, and without a rule the winner is whichever `defineCrud` generated first —
     * a routing table whose behaviour depends on import order.
     */
    it('prefers a literal segment over a parameter', () => {
        const table = routeTable([
            call('site.get', 'GET', '/sites/:id'),
            call('site.count', 'GET', '/sites/count'),
        ]);

        const matched = matchRoute(table, 'GET', '/sites/count');
        expect(matched).toMatchObject({ found: true, match: { call: { key: 'site.count' } } });
    });

    it('pulls parameters out of the path, decoded', () => {
        const table = routeTable([call('site.get', 'GET', '/sites/:id')]);
        const matched = matchRoute(table, 'GET', '/sites/a%20b');

        expect(matched).toMatchObject({ found: true, match: { params: { id: 'a b' } } });
    });

    /**
     * *You typed the wrong path* and *you used the wrong verb* are different problems for whoever is
     * reading the error, and conflating them has cost afternoons.
     */
    it('distinguishes a wrong method from a wrong path', () => {
        const table = routeTable([call('site.find', 'GET', '/sites')]);

        expect(matchRoute(table, 'POST', '/sites')).toMatchObject({ reason: 'method_not_allowed' });
        expect(matchRoute(table, 'GET', '/nothing')).toMatchObject({ reason: 'no_route' });
    });
});

describe('route over query over body', () => {
    it('lets the route win, because the route was verified', () => {
        const merged = mergeInput({ id: 'from-route' }, {}, { id: 'from-body' });
        expect(merged).toMatchObject({ conflict: expect.stringContaining('from-route') });
    });

    it('is not a conflict when they agree', () => {
        const merged = mergeInput({ id: 'same' }, {}, { id: 'same' });
        expect(merged).toMatchObject({ input: { id: 'same' } });
    });

    it('lets the query beat the body', () => {
        const merged = mergeInput({}, { limit: 5 }, { limit: 100 });
        expect(merged).toMatchObject({ input: { limit: 5 } });
    });

    /**
     * **A disagreement is an error, not a value to discard quietly.** Silently preferring one of two
     * conflicting values is how a caller ends up convinced they wrote something they did not write.
     */
    it('names both values in the conflict, so it can be fixed without guessing', () => {
        const merged = mergeInput({ organizationId: 'a' }, {}, { organizationId: 'b' });
        expect(merged).toMatchObject({ conflict: expect.stringContaining('"a"') });
        expect(merged).toMatchObject({ conflict: expect.stringContaining('"b"') });
    });
});

/**
 * A query string carries strings, and `query` is a record while `limit` is a number — so both were
 * unpassable over GET until this existed. Every generated find takes them, and the platform's
 * complaint that nothing passes them was partly that nothing could.
 */
describe('decoding a query string', () => {
    it('parses an object and an array', () => {
        expect(decodeQueryValue('{"userId":"x"}')).toEqual({ userId: 'x' });
        expect(decodeQueryValue('["a","b"]')).toEqual(['a', 'b']);
    });

    it('parses a number and a boolean', () => {
        expect(decodeQueryValue('10')).toBe(10);
        expect(decodeQueryValue('-2.5')).toBe(-2.5);
        expect(decodeQueryValue('true')).toBe(true);
    });

    /**
     * The reason it is narrow. A hostname must stay a string, or `site.find` by host stops working
     * on exactly the address a fresh node serves itself on.
     */
    it('leaves a hostname alone', () => {
        expect(decodeQueryValue('127.0.0.1')).toBe('127.0.0.1');
        expect(decodeQueryValue('example.com')).toBe('example.com');
    });

    it('leaves malformed JSON as the string it was, for the schema to refuse by name', () => {
        expect(decodeQueryValue('{not json')).toBe('{not json');
    });

    it('decodes a whole query string', () => {
        const decoded = decodeQuery(new URLSearchParams('limit=5&host=127.0.0.1&query={"a":1}'));
        expect(decoded).toEqual({ limit: 5, host: '127.0.0.1', query: { a: 1 } });
    });
});
