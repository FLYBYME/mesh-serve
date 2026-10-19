import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import type { ContractDeclaration } from '@flybyme/mesh';
import { buildDescriptor } from '../../../src/api/methods/descriptor.js';
import { gateLiteral, generateClient, inlineLocalRefs, renderClient } from '../../../src/api/methods/generateClient.js';
import type { Expose } from '../../../src/api/contracts/expose.contract.js';

/**
 * A call's input is typed by what a caller *passes* — `z.input` — not by what the server receives
 * after defaults are applied (`z.infer`). With `z.infer`, `domain.find`'s defaulted `offset` was
 * required at every call site.
 */
const row: Expose = {
    id: 'row-1', tenantId: 't', apiId: 'api', kind: 'contract', contract: 'domain.find',
    createdAt: new Date(0), updatedAt: new Date(0),
};

const declaration: ContractDeclaration = {
    key: 'domain.find', domain: 'domain', action: 'find', description: 'Find domains.',
    rest: { method: 'GET', path: '/domains' }, visibility: 'public', permissions: [], destructive: false,
    input: {
        type: 'object',
        properties: { limit: { type: 'number', default: 100 }, offset: { type: 'number', default: 0 } },
    },
    output: { type: 'array', items: { type: 'string' } },
};

describe('a call\'s gate, read from the descriptor', () => {
    it('is nothing for a public call', () => {
        expect(gateLiteral('public')).toBe('undefined');
    });

    it('is the role, or the last role (the expose row\'s, after the contract\'s floor)', () => {
        expect(gateLiteral('operator')).toBe(`{ kind: 'role', role: "operator" }`);
        expect(gateLiteral('user+admin')).toBe(`{ kind: 'role', role: "admin" }`);
    });

    it('is the permission when there is one — the most specific thing a caller must hold', () => {
        expect(gateLiteral('operator+permission:dns.write')).toBe(`{ kind: 'permission', permission: "dns.write" }`);
    });
});

describe('rendering from a described api, as `mesh-serve generate` does locally', () => {
    it('is the same text the server renders from its rows', async () => {
        const described = buildDescriptor('api.test', [row], () => declaration);
        const onServer = await generateClient('api.test', 'api.test', [row], () => declaration);
        expect(renderClient('api.test', described)).toBe(onServer);
    });
});

describe('the generated client', () => {
    it('types a call by its schema\'s input side, so defaulted fields are optional to a caller', async () => {
        const source = await generateClient('api.test', 'api.test', [row], () => declaration);
        expect(source).toContain('"domain.find": /* @__PURE__ */ call<z.input<typeof domainFindInputSchema>, DomainFindOutput, never>(');
        // The named parsed type is still emitted, for code that holds a parsed value.
        expect(source).toMatch(/export type DomainFindInput = z\.infer<typeof domainFindInputSchema>/);
    });

    it('declares the events the api streams, so models treat those collections as live', () => {
        // From a descriptor, as `/api/_describe` hands it over: buildDescriptor only lists events
        // this process could deliver, and none are registered in a unit test.
        const described = {
            ...buildDescriptor('api.test', [row], () => declaration),
            events: [{ name: 'domain.created', gate: { kind: 'role', role: 'operator' } as const }, { name: 'domain.deleted' }],
        };
        const source = renderClient('api.test', described);
        expect(source).toContain([
            '    events: [',
            `        { name: "domain.created", gate: { kind: 'role', role: "operator" } },`,
            '        { name: "domain.deleted" },',
            '    ],',
        ].join('\n'));
    });

    it('writes no events entry for an api that streams none', async () => {
        const source = await generateClient('api.test', 'api.test', [row], () => declaration);
        expect(source).not.toContain('events:');
    });

    it('a bundle that does not use the api drops it, and every schema it does not read', async () => {
        const unusedRow: Expose = { ...row, id: 'row-2', contract: 'note.find' };
        const unused: ContractDeclaration = {
            ...declaration, key: 'note.find', domain: 'note', rest: { method: 'GET', path: '/notes' },
            input: { type: 'object', properties: { neverReadMarker: { type: 'string' } } },
        };
        const source = await generateClient('api.test', 'api.test', [row, unusedRow], (key) => (key === 'note.find' ? unused : declaration));

        const bundle = await esbuild.build({
            stdin: { contents: "import { domainFindInputSchema } from 'client'; console.log(domainFindInputSchema);", loader: 'ts' },
            bundle: true,
            write: false,
            format: 'esm',
            external: ['zod', '@flybyme/mesh-web/net'],
            plugins: [{
                name: 'client',
                setup(build) {
                    build.onResolve({ filter: /^client$/ }, () => ({ path: 'client', namespace: 'client' }));
                    build.onLoad({ filter: /.*/, namespace: 'client' }, () => ({ contents: source, loader: 'ts' }));
                },
            }],
        });
        const text = bundle.outputFiles[0]?.text ?? '';

        expect(text).toContain('domainFindInputSchema');
        expect(text).not.toContain('neverReadMarker');
    });

    it('a bundle that uses the api carries each call\'s input schema, to check inputs before they are sent -- and no output schema', async () => {
        const source = await generateClient('api.test', 'api.test', [row], () => ({
            ...declaration, output: { type: 'object', properties: { outputOnlyMarker: { type: 'string' } } },
        }));
        expect(source).toContain('{ inputSchema: domainFindInputSchema }');

        const bundle = await esbuild.build({
            stdin: { contents: "import { apiTestApi } from 'client'; console.log(apiTestApi);", loader: 'ts' },
            bundle: true,
            write: false,
            format: 'esm',
            external: ['zod', '@flybyme/mesh-web/net'],
            plugins: [{
                name: 'client',
                setup(build) {
                    build.onResolve({ filter: /^client$/ }, () => ({ path: 'client', namespace: 'client' }));
                    build.onLoad({ filter: /.*/, namespace: 'client' }, () => ({ contents: source, loader: 'ts' }));
                },
            }],
        });
        const text = bundle.outputFiles[0]?.text ?? '';

        expect(text).toContain('domainFindInputSchema');
        expect(text).not.toContain('outputOnlyMarker');
    });
});

/**
 * zod-to-json-schema writes a reused zod schema as a `$ref` to its first use; rendered as is, it
 * became `z.any()` (builds' volumes, 10-18).
 */
describe('a local $ref', () => {
    const sizeGb = { type: 'integer', minimum: 1, maximum: 200 };
    const schema = {
        type: 'object',
        properties: {
            disk: { type: 'object', properties: { sizeGb } },
            volumes: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: { sizeGb: { $ref: '#/properties/disk/properties/sizeGb', description: 'grows' } },
                },
            },
        },
    };

    it('is replaced by what it points at, keeping its own keywords', () => {
        const inlined = inlineLocalRefs(schema);

        expect(inlined).toEqual({
            type: 'object',
            properties: {
                disk: { type: 'object', properties: { sizeGb } },
                volumes: {
                    type: 'array',
                    items: { type: 'object', properties: { sizeGb: { ...sizeGb, description: 'grows' } } },
                },
            },
        });
    });

    it('renders a real type in the client, not any', () => {
        const volumeSet: ContractDeclaration = { ...declaration, key: 'environment.volume_set', domain: 'environment', action: 'volume_set', output: schema };
        const text = renderClient('api', buildDescriptor('api.test', [{ ...row, contract: 'environment.volume_set' }], () => volumeSet));

        expect(text).not.toContain('z.any()');
        expect(text).toContain('"sizeGb": z.number().int().gte(1).lte(200).describe("grows")');
    });

    it('stays a $ref where it would repeat forever', () => {
        const cyclic = { type: 'object', properties: { a: { type: 'object', properties: { next: { $ref: '#/properties/a' } } } } };

        expect(inlineLocalRefs(cyclic)).toEqual({
            type: 'object',
            properties: {
                a: {
                    type: 'object',
                    properties: { next: { type: 'object', properties: { next: { $ref: '#/properties/a' } } } },
                },
            },
        });
    });
});
