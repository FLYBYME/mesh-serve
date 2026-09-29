import { describe, expect, it } from 'vitest';
import type { ContractDeclaration } from '@flybyme/mesh';
import { generateClient } from '../../../src/api/methods/generateClient.js';
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

describe('the generated client', () => {
    it('types a call by its schema\'s input side, so defaulted fields are optional to a caller', async () => {
        const source = await generateClient('api.test', 'api.test', [row], () => declaration);
        expect(source).toContain('"domain.find": call<z.input<typeof domainFindInputSchema>, DomainFindOutput, never>(');
        // The named parsed type is still emitted, for code that holds a parsed value.
        expect(source).toMatch(/export type DomainFindInput = z\.infer<typeof domainFindInputSchema>/);
    });
});
