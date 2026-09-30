import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { typedQueryValues } from '../../../src/api/gateway.js';

/**
 * A GET's query string has only strings. `k8s.logs?lines=100` reached the tool as `lines: "100"`
 * and was refused (2026-09-30). The gateway types them by the contract's input schema -- the JSON
 * Schema a declaration carries, which is `zodToJsonSchema` of the contract's zod input.
 */
const schemaOf = (input: z.ZodTypeAny): Record<string, unknown> => {
    const out: unknown = zodToJsonSchema(input);
    return typeof out === 'object' && out !== null ? Object.fromEntries(Object.entries(out)) : {};
};

const logsInput = schemaOf(z.object({
    cluster: z.string(),
    pod: z.string(),
    namespace: z.string(),
    container: z.string().optional(),
    lines: z.number().int().optional(),
    since: z.string().optional(),
    follow: z.boolean().optional(),
    ratio: z.number().nullable().optional(),
}));

describe('typedQueryValues', () => {
    it('turns the numbers and booleans the schema declares into numbers and booleans', () => {
        expect(typedQueryValues({ cluster: 'surfdns', pod: 'p', namespace: 'n', lines: '100', follow: 'false', ratio: '0.5' }, logsInput))
            .toEqual({ cluster: 'surfdns', pod: 'p', namespace: 'n', lines: 100, follow: false, ratio: 0.5 });
    });

    it('leaves a string field alone even when it looks like a number', () => {
        // `since` may be "300" (seconds); it is a string field and must reach the tool as one.
        expect(typedQueryValues({ since: '300', pod: '123' }, logsInput)).toEqual({ since: '300', pod: '123' });
    });

    it('leaves a value that is not exactly a number or boolean for the schema to refuse', () => {
        expect(typedQueryValues({ lines: '10abc', follow: 'yes' }, logsInput)).toEqual({ lines: '10abc', follow: 'yes' });
    });

    it('leaves decoded objects, unknown fields, and a schema without properties alone', () => {
        const input = { query: { id: 'x' }, extra: '5' };
        expect(typedQueryValues(input, logsInput)).toEqual(input);
        expect(typedQueryValues({ lines: '5' }, {})).toEqual({ lines: '5' });
    });
});
