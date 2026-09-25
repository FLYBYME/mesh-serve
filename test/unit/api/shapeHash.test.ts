import { describe, expect, it } from 'vitest';
import type { ContractDeclaration } from '@flybyme/mesh';
import { buildDescriptor } from '../../../src/api/methods/descriptor.js';
import type { Expose } from '../../../src/api/contracts/expose.contract.js';

/**
 * surfdns-repo's repoAccess has `grantedAt` defaulting to "now", and its JSON Schema therefore
 * carried `"default": "<the current time>"` -- a new value every time the descriptor was built,
 * which is every request. The shape hash changed on every response, so a client never matched its
 * cached comparison and fetched /api/_describe before every single call (seen on surfdns.net).
 */
const row: Expose = {
    id: 'row-1', tenantId: 't', apiId: 'api', kind: 'contract', contract: 'grant.get',
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
};

function declarationAt(now: string, extra: Record<string, unknown> = {}): ContractDeclaration {
    return {
        key: 'grant.get', domain: 'grant', action: 'get', description: '',
        rest: { method: 'GET', path: '/grants/:id' }, visibility: 'public', permissions: [], destructive: false,
        input: { type: 'object', properties: { id: { type: 'string' } } },
        output: { type: 'object', properties: { grantedAt: { type: 'string', format: 'date-time', default: now }, ...extra } },
    };
}

describe('the shape hash', () => {
    it('does not change with a default computed from the clock', () => {
        const first = buildDescriptor('api.test', [row], () => declarationAt('2026-09-25T23:42:00.996Z'));
        const second = buildDescriptor('api.test', [row], () => declarationAt('2026-09-25T23:42:02.334Z'));
        expect(second.shapeHash).toBe(first.shapeHash);
    });

    it('still changes when the shape does', () => {
        const before = buildDescriptor('api.test', [row], () => declarationAt('x'));
        const after = buildDescriptor('api.test', [row], () => declarationAt('x', { revokedAt: { type: 'string' } }));
        expect(after.shapeHash).not.toBe(before.shapeHash);
    });
});
