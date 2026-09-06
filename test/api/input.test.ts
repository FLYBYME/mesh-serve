/**
 * Coercing a query string toward what the contract declares.
 *
 * A URL carries strings and a contract declares types, and something has to bridge them. This file
 * exists because that bridge had a hole in it that nothing covered: `coerceToSchema` had no test at
 * all, and the one shape it did not handle was the one every generated `find` sends.
 */

import { z } from '@flybyme/mesh';
import { describe, expect, it } from 'vitest';

import { coerceToSchema } from '../../src/api/methods/input.js';

describe('a query string becomes what the contract asked for', () => {
    it('parses an object, which every generated find depends on', () => {
        /**
         * The defect. `defineCrud`'s `find` takes `query` as an object, and the generated client
         * sends `GET /parts?query=%7B%7D` — which is `{}`. Numbers, booleans and arrays were
         * coerced; objects were not, so the schema received the literal string `"{}"` and answered
         * *"query: Expected object, received string"*.
         *
         * Every list call from a browser failed, on every collection, from the moment F2 exposed
         * one. Found by the first console to get past authentication — the layers above had been
         * refusing these calls for other reasons and hiding it.
         */
        const schema = z.object({ query: z.record(z.string(), z.unknown()).optional() });

        expect(coerceToSchema(schema, { query: '{}' })).toEqual({ query: {} });
        expect(coerceToSchema(schema, { query: '{"host":"a.test"}' }))
            .toEqual({ query: { host: 'a.test' } });
    });

    it('leaves a string that is not JSON alone, so the schema rejects it', () => {
        // A coercion that throws turns a bad query into a 500, and the whole point of coercing at
        // the boundary is that a bad request is a 400 naming the field.
        const schema = z.object({ query: z.record(z.string(), z.unknown()).optional() });

        expect(coerceToSchema(schema, { query: 'not json' })).toEqual({ query: 'not json' });
        expect(coerceToSchema(schema, { query: '{oops' })).toEqual({ query: '{oops' });
    });

    it('still coerces the scalars it always did', () => {
        const schema = z.object({
            limit: z.number().optional(),
            deep: z.boolean().optional(),
            tag: z.array(z.string()).optional(),
        });

        expect(coerceToSchema(schema, { limit: '25', deep: 'true', tag: 'a' }))
            .toEqual({ limit: 25, deep: true, tag: ['a'] });
    });

    it('leaves an empty string for a number alone, because an empty string is not zero', () => {
        const schema = z.object({ limit: z.number().optional() });
        expect(coerceToSchema(schema, { limit: '' })).toEqual({ limit: '' });
    });
});
