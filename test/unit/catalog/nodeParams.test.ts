/**
 * An onStart entry's params name the node they run on: one smtp part on every edge greets as each
 * machine's own name.
 */
import { describe, expect, it } from 'vitest';

import { nodeParams } from '../../../src/catalog/methods/onStart.js';

describe('nodeParams', () => {
    const labels = { role: 'edge', fqdn: 'ns1.surfdns.net' };

    it('fills ${node.id} and ${node.<label>} from the node it runs on', () => {
        const params = nodeParams({ hostname: '${node.fqdn}', banner: 'mx ${node.id} (${node.role})', port: 25 }, 'ns1', labels);

        expect(params).toEqual({ hostname: 'ns1.surfdns.net', banner: 'mx ns1 (edge)', port: 25 });
    });

    it('reaches into arrays and objects, and leaves everything else alone', () => {
        const params = nodeParams({ names: ['${node.fqdn}', 'x'], tls: { sni: '${node.fqdn}', on: true }, none: null }, 'ns1', labels);

        expect(params).toEqual({ names: ['ns1.surfdns.net', 'x'], tls: { sni: 'ns1.surfdns.net', on: true }, none: null });
    });

    it('refuses a label the node does not carry, rather than greeting with the placeholder', () => {
        expect(() => nodeParams({ hostname: '${node.fqdn}' }, 'surf', { role: 'edge' })).toThrow(/surf has no "fqdn" label/);
    });

    it('passes params with no placeholder through unchanged', () => {
        expect(nodeParams({ port: 53, host: '0.0.0.0' }, 'ns1', labels)).toEqual({ port: 53, host: '0.0.0.0' });
    });
});
