import { describe, expect, it } from 'vitest';
import { JsonSchemaToCli } from '../src/cli/core/JsonSchemaToCli.js';

describe('JsonSchemaToCli.parseOptions', () => {
    const schema = {
        type: 'object',
        properties: {
            containers: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } },
            tags: { type: 'array', items: { type: 'string' } },
        },
    };

    it('takes a whole JSON array given as one flag value, not as its first item', () => {
        // `--containers '[{...}]'` was stored as [[{...}]] and the group could not be read back (2026-09-27).
        const out = JsonSchemaToCli.parseOptions({ containers: ['[{"name":"a"},{"name":"b"}]'] }, schema);
        expect(out).toEqual({ containers: [{ name: 'a' }, { name: 'b' }] });
    });

    it('still takes one item per value when each value is an item', () => {
        expect(JsonSchemaToCli.parseOptions({ containers: ['{"name":"a"}', '{"name":"b"}'] }, schema))
            .toEqual({ containers: [{ name: 'a' }, { name: 'b' }] });
        expect(JsonSchemaToCli.parseOptions({ tags: ['x', 'y'] }, schema)).toEqual({ tags: ['x', 'y'] });
    });
});
