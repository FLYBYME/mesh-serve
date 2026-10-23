import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { defineEvent, z, type ContractDeclaration } from '@flybyme/mesh';
import { buildDescriptor, eventPayloadOf } from '../../../src/api/methods/descriptor.js';
import type { Expose } from '../../../src/api/contracts/expose.contract.js';

/** What one occurrence of an event carries, described so a client can type and check it (10-23). */
const rowSchema = { type: 'object', properties: { id: { type: 'string' }, tenantId: { type: 'string' }, host: { type: 'string' } }, required: ['id', 'tenantId', 'host'] };

const getDeclaration: ContractDeclaration = {
    key: 'site.get', domain: 'site', action: 'get', description: 'One site.',
    rest: { method: 'GET', path: '/sites/:id' }, visibility: 'public', permissions: ['member'], destructive: false,
    input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    output: rowSchema,
};

const declare = (key: string): ContractDeclaration | undefined => (key === 'site.get' ? getDeclaration : undefined);

defineEvent('payloadtest.pinged', z.object({ tenantId: z.string(), at: z.string() }), { scopedBy: 'tenantId', permissions: ['member'] });

describe('an event\'s payload', () => {
    it('is a defined event\'s own schema', () => {
        expect(eventPayloadOf('payloadtest.pinged', declare)).toEqual(expect.objectContaining({
            type: 'object', properties: { tenantId: { type: 'string' }, at: { type: 'string' } }, required: ['tenantId', 'at'],
        }));
    });

    it('is a collection\'s row for created, and the row inside what updated and deleted carry', () => {
        expect(eventPayloadOf('site.created', declare)).toEqual(rowSchema);
        expect(eventPayloadOf('site.updated', declare)).toEqual({
            type: 'object',
            properties: { id: { type: 'string' }, patch: { type: 'object', additionalProperties: true }, item: rowSchema },
            required: ['id', 'patch', 'item'],
        });
        expect(eventPayloadOf('site.deleted', declare)).toEqual(expect.objectContaining({
            properties: expect.objectContaining({ id: { type: 'string' }, item: rowSchema }),
            required: ['id'],
        }));
    });

    it('is unknown for anything else', () => {
        expect(eventPayloadOf('site.published', declare)).toBeUndefined();
        expect(eventPayloadOf('nothing.created', declare)).toBeUndefined();
    });
});

describe('describing payloads', () => {
    it('leaves the exposure hash as it was: by event name and gate only, so no client already built goes stale', () => {
        const row: Expose = {
            id: 'row-e', tenantId: 't', apiId: 'api', kind: 'event', contract: 'payloadtest.pinged',
            createdAt: new Date(0), updatedAt: new Date(0),
        };
        const described = buildDescriptor('api.test', [row], declare);

        expect(described.events[0]?.payload).toBeDefined();
        const expected = crypto.createHash('sha256')
            .update(JSON.stringify([]))
            .update(JSON.stringify([{ name: 'payloadtest.pinged', gate: { kind: 'role', role: 'member' } }]))
            .digest('hex');
        expect(described.exposure).toBe(expected);
    });
});
