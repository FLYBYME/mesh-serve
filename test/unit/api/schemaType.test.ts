import { describe, expect, it } from 'vitest';
import { typeOf, zodTypeOf } from '../../../src/api/methods/schemaType.js';

/**
 * The type json-schema-to-zod's zod gives, written out. Held to zod itself across a live api's
 * 1,460 schemas when made (10-23: both directions assignable, and `any` only where zod has it);
 * these are the cases that differ from a plain reading of the schema.
 */
describe('a schema\'s type, as zod gives it', () => {
    it('a field not required may be left out; one with a default only by a caller', () => {
        const schema = {
            type: 'object',
            properties: { a: { type: 'string' }, b: { type: 'number', default: 1 }, c: { type: 'boolean' } },
            required: ['c'],
        };
        expect(typeOf(schema, 'output')).toBe('{ "a"?: string | undefined; "b": number; "c": boolean }');
        expect(typeOf(schema, 'input')).toBe('{ "a"?: string | undefined; "b"?: number | undefined; "c": boolean }');
    });

    it('a required field of any type may still be left out, as zod has it', () => {
        expect(typeOf({ type: 'object', properties: { x: {} }, required: ['x'] }, 'output')).toBe('{ "x"?: any }');
    });

    it('nullable, enums, consts and several types are unions', () => {
        expect(typeOf({ type: 'string', nullable: true }, 'output')).toBe('(string) | (null)');
        expect(typeOf({ enum: ['a', 'b'] }, 'output')).toBe('("a") | ("b")');
        expect(typeOf({ const: 3 }, 'output')).toBe('3');
        expect(typeOf({ type: ['string', 'null'] }, 'output')).toBe('(string) | (null)');
    });

    it('extra keys are an index; no fields at all a record; `not` is any', () => {
        expect(typeOf({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: { type: 'number' } }, 'output'))
            .toBe('({ "a": string }) & ({ [key: string]: number })');
        expect(typeOf({ type: 'object' }, 'output')).toBe('Record<string, any>');
        expect(typeOf({ not: { type: 'string' } }, 'output')).toBe('any');
    });

    it('`not: {}` is nothing: a find_one is its record or undefined, never any', () => {
        const record = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false };

        expect(typeOf({ anyOf: [{ not: {} }, record] }, 'output')).toBe('{ "id": string } | undefined');
        expect(typeOf({ anyOf: [{ not: {} }, { type: 'string' }, { type: 'number' }] }, 'output')).toBe('(string) | (number) | undefined');
        expect(typeOf({ type: 'object', properties: { a: { anyOf: [{ not: {} }, { type: 'string' }] } }, required: ['a'] }, 'output'))
            .toBe('{ "a"?: string | undefined }');
    });
});

describe('the declared type of a generated schema', () => {
    it('an object keeps its shape, so a form can extend it', () => {
        const schema = { type: 'object', properties: { email: { type: 'string' } }, required: ['email'], additionalProperties: false };
        expect(zodTypeOf(schema, 'Out', 'In'))
            .toBe('z.ZodObject<{ "email": z.ZodType<string, z.ZodTypeDef, string> }, \'strict\', z.ZodTypeAny, Out, In>');
    });

    it('anything else is a ZodType of the named types', () => {
        expect(zodTypeOf({ anyOf: [{ type: 'string' }, { type: 'number' }] }, 'Out', 'In')).toBe('z.ZodType<Out, z.ZodTypeDef, In>');
    });
});
