import { describe, expect, it } from 'vitest';
import { descriptorKey, type NodeTools } from '../src/api/methods/descriptorKey.js';

const rows = [{ apiId: 'a', contract: 'repo.find', role: 'member' }];
const edge: NodeTools = { nodeID: 'edge1-edge', services: [{ tools: { 'repo.find': { hash: 'h1' }, 'serve.api.listen': { hash: 'h2' } } }] };
const core: NodeTools = { nodeID: 'core', services: [{ tools: { 'build.find': { hash: 'h3' } } }] };

describe('an api descriptor\'s key (owner\'s profile, 10-16: describe rebuilt every 10 s)', () => {
    it('the same api, rows and cluster: the same key, whichever order the nodes come in', () => {
        expect(descriptorKey('api.surfdns.net', rows, [edge, core])).toBe(descriptorKey('api.surfdns.net', [...rows], [core, edge]));
    });

    it('changes when a contract served changes, a row changes, or the host differs', () => {
        const base = descriptorKey('api.surfdns.net', rows, [edge, core]);
        const changed: NodeTools = { nodeID: 'core', services: [{ tools: { 'build.find': { hash: 'h3-new' } } }] };

        expect(descriptorKey('api.surfdns.net', rows, [edge, changed])).not.toBe(base);
        expect(descriptorKey('api.surfdns.net', [...rows, { apiId: 'a', contract: 'build.find' }], [edge, core])).not.toBe(base);
        expect(descriptorKey('api.example.com', rows, [edge, core])).not.toBe(base);
    });

    it('a node that is not available is not part of it, as it serves nothing', () => {
        expect(descriptorKey('api.surfdns.net', rows, [edge, { ...core, available: false }])).toBe(descriptorKey('api.surfdns.net', rows, [edge]));
    });
});
