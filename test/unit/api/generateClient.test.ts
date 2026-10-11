import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import type { ContractDeclaration } from '@flybyme/mesh';
import { buildDescriptor } from '../../../src/api/methods/descriptor.js';
import { gateLiteral, generateClient, renderClient } from '../../../src/api/methods/generateClient.js';
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
        expect(source).toContain('"domain.find": call<z.input<typeof domainFindInputSchema>, DomainFindOutput, never>(');
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

    it('ships only the schemas a bundle reads at run time: the rest are dropped', async () => {
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
});
