import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import type { ContractDeclaration } from '@flybyme/mesh';
import { buildDescriptor, type DescribedCall, type DescribedEvent, type ExposureDescriptor } from '../../../src/api/methods/descriptor.js';
import { filterDescriptor, gateLiteral, generateClient, inlineLocalRefs, renderClient } from '../../../src/api/methods/generateClient.js';
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
        expect(source).toContain('"domain.find": /* @__PURE__ */ call<DomainFindRequest, DomainFindOutput, never>(');
        expect(source).toContain('export type DomainFindRequest = { "limit"?: number | undefined; "offset"?: number | undefined }');
        // The named parsed type is still emitted, for code that holds a parsed value.
        expect(source).toContain('export type DomainFindInput = { "limit": number; "offset": number }');
    });

    it('writes every type out and is never checked, so no zod expression is inferred', async () => {
        const source = await generateClient('api.test', 'api.test', [row], () => declaration);
        expect(source.startsWith('// @ts-nocheck')).toBe(true);
        expect(source).not.toContain('z.infer<');
        expect(source).not.toContain('z.input<');
        expect(source).toContain('export const domainFindInputSchema: z.ZodObject<{ "limit": z.ZodType<number, z.ZodTypeDef, number | undefined>; "offset": z.ZodType<number, z.ZodTypeDef, number | undefined> }, \'strip\', z.ZodTypeAny, DomainFindInput, DomainFindRequest> =');
        expect(source).toContain('export const domainFindOutputSchema: z.ZodArray<z.ZodType<string, z.ZodTypeDef, string>> =');
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

    it('types each event by its payload, and keeps a schema to check one by; one with none described is unknown', () => {
        const payload = { type: 'object', properties: { id: { type: 'string' }, host: { type: 'string' } }, required: ['id', 'host'] };
        const described = {
            ...buildDescriptor('api.test', [row], () => declaration),
            events: [{ name: 'domain.created', payload }, { name: 'domain.deleted' }],
        };
        const source = renderClient('api.test', described);

        expect(source).toContain('export type DomainCreatedEvent = { "id": string; "host": string }');
        expect(source).toContain('export const domainCreatedEventSchema: z.ZodObject<');
        expect(source).toContain(['export type ApiTestEvents = {', '    "domain.created": DomainCreatedEvent;', '    "domain.deleted": unknown;', '};'].join('\n'));
        expect(source).toContain('export type ApiTestEventName = keyof ApiTestEvents;');
        expect(source).toContain(['export const apiTestEventSchemas = /* @__PURE__ */ (() => ({', '    "domain.created": domainCreatedEventSchema,', '}))();'].join('\n'));
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDescribedCall(value: unknown): value is DescribedCall {
    if (!isRecord(value)) return false;
    return typeof value.key === 'string' &&
        typeof value.domain === 'string' &&
        typeof value.action === 'string' &&
        typeof value.description === 'string' &&
        typeof value.method === 'string' &&
        typeof value.path === 'string' &&
        typeof value.gate === 'string' &&
        'input' in value &&
        'output' in value;
}

function isDescribedEvent(value: unknown): value is DescribedEvent {
    if (!isRecord(value)) return false;
    return typeof value.name === 'string';
}

function isExposureDescriptor(value: unknown): value is ExposureDescriptor {
    if (!isRecord(value)) return false;
    if (typeof value.host !== 'string') return false;
    if (typeof value.base !== 'string') return false;
    if (typeof value.exposure !== 'string') return false;
    if (typeof value.shapeHash !== 'string') return false;
    if (!Array.isArray(value.calls) || !value.calls.every(isDescribedCall)) return false;
    if (!Array.isArray(value.events) || !value.events.every(isDescribedEvent)) return false;
    return true;
}

describe('generate --only <patterns> over the real live descriptor', () => {
    const descriptorPath = path.join(os.homedir(), 'code/agy/live-rows/api.surfdns.net._describe.json');
    const raw = fs.readFileSync(descriptorPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isExposureDescriptor(parsed)) {
        throw new Error('Expected api.surfdns.net._describe.json to match ExposureDescriptor');
    }
    const realDescriptor = parsed;

    it('--only \'infer.*\' keeps only infer calls and events, every one of them', () => {
        const filtered = filterDescriptor(realDescriptor, 'infer.*');
        expect(filtered.calls.length).toBe(88);
        expect(filtered.calls.every((c) => c.key.startsWith('infer.'))).toBe(true);
        expect(filtered.events.length).toBe(42);
        expect(filtered.events.every((e) => e.name.startsWith('infer.'))).toBe(true);
    });

    it('the output compiles and asserts on its text and structure', async () => {
        const filtered = filterDescriptor(realDescriptor, 'infer.*');
        const text = renderClient(filtered.host, filtered, { only: 'infer.*' });

        expect(text).toContain('// Only: infer.*');
        expect(text).toContain('export const apiSurfdnsNetApi = /* @__PURE__ */ defineApi({');
        expect(text).toContain('"infer.thread.complete": /* @__PURE__ */ call<');
        expect(text).toContain('"infer.message.created"');

        const bundle = await esbuild.build({
            stdin: { contents: text, loader: 'ts' },
            bundle: false,
            write: false,
            format: 'esm',
        });
        expect(bundle.outputFiles.length).toBe(1);
        const output = bundle.outputFiles[0];
        if (output === undefined) throw new Error('expected output file');
        expect(output.text.length).toBeGreaterThan(0);
    });

    it('a collection kept by one call keeps its find and events', () => {
        const filtered = filterDescriptor(realDescriptor, 'infer.agentPersona.get');
        const callKeys = filtered.calls.map((c) => c.key);
        expect(callKeys).toEqual(['infer.agentPersona.find', 'infer.agentPersona.get']);

        const eventNames = filtered.events.map((e) => e.name);
        expect(eventNames).toEqual([
            'infer.agentPersona.created',
            'infer.agentPersona.deleted',
            'infer.agentPersona.updated',
        ]);
    });

    it('a pattern matching nothing fails naming it', () => {
        expect(() => filterDescriptor(realDescriptor, 'infer.*,identity.nosuchthing'))
            .toThrow('identity.nosuchthing');
        expect(() => filterDescriptor(realDescriptor, 'nosuchcall.*'))
            .toThrow('nosuchcall.*');
    });

    it('no --only gives today\'s output exactly', () => {
        const fullOutput = renderClient(realDescriptor.host, realDescriptor);
        expect(fullOutput).not.toContain('// Only:');
        expect(renderClient(realDescriptor.host, realDescriptor, undefined)).toBe(fullOutput);
    });

    it('the size: --only \'infer.*,identity.*\' is under a fifth of the full file', () => {
        const fullOutput = renderClient(realDescriptor.host, realDescriptor);
        const filtered = filterDescriptor(realDescriptor, 'infer.*,identity.*');
        const filteredOutput = renderClient(filtered.host, filtered, { only: 'infer.*,identity.*' });

        expect(filteredOutput.length).toBeLessThan(fullOutput.length / 5);
    });
});
