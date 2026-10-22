import { describe, expect, it } from 'vitest';

import { maskHold, maskHoldInput, type Hold } from '../../../src/hold/contracts/hold.contract.js';

describe('hold mask', () => {
    it('masks top-level secret fields and preserves non-secret fields', () => {
        const input = {
            name: 'my-service',
            token: 'secret-token',
            password: 'super-password',
            nested: { secret: 'nested-stays' },
        };

        const masked = maskHoldInput(input);

        expect(masked.name).toBe('my-service');
        expect(masked.token).toBe('hidden');
        expect(masked.password).toBe('hidden');
        expect(masked.nested).toEqual({ secret: 'nested-stays' });
    });

    it('returns the same input reference when no secret fields exist', () => {
        const input = { name: 'safe', count: 42 };

        expect(maskHoldInput(input)).toBe(input);
    });

    it('masks secrets on a hold row without mutating other properties', () => {
        const row: Hold = {
            id: 'h-1',
            createdAt: new Date(),
            updatedAt: new Date(),
            tenantId: 'tenant-1',
            call: 'service.deploy',
            host: 'api.localhost',
            input: { apiKey: 'key-123', region: 'us-east' },
            requestedBy: { userId: 'u-1', roles: ['admin'] },
            requestedAt: new Date(),
            status: 'held',
            expiresAt: new Date(),
        };

        const masked = maskHold(row);

        expect(masked.id).toBe('h-1');
        expect(masked.tenantId).toBe('tenant-1');
        expect(masked.input.apiKey).toBe('hidden');
        expect(masked.input.region).toBe('us-east');
        expect(row.input.apiKey).toBe('key-123');
    });
});
