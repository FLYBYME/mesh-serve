/**
 * The edge record: id and url, and genuinely nothing else.
 *
 * M2: "One row per running edge: id and url. That is genuinely the whole schema,
 * and the restraint is the design."
 */

import { describe, expect, it } from 'vitest';

import { edgeCrud } from '../../src/cdn/contracts/edge.contract.js';
import { EdgeSchema } from '../../src/cdn/schema/edge.js';

describe('EdgeSchema', () => {
    it('accepts a valid edge with a URL', () => {
        const parsed = EdgeSchema.safeParse({ url: 'http://127.0.0.1:8080' });
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.url).toBe('http://127.0.0.1:8080');
        }
    });

    it('refuses an empty URL', () => {
        const parsed = EdgeSchema.safeParse({ url: '' });
        expect(parsed.success).toBe(false);
    });

    it('refuses a record missing url', () => {
        const parsed = EdgeSchema.safeParse({});
        expect(parsed.success).toBe(false);
    });

    it('refuses liveness and status fields because the schema is strict', () => {
        // Not liveness: the mesh already knows which nodes are connected.
        // A second heartbeat or status field creates two sources of truth.
        const withStatus = EdgeSchema.safeParse({ url: 'http://127.0.0.1:8080', status: 'healthy' });
        expect(withStatus.success).toBe(false);

        const withHeartbeat = EdgeSchema.safeParse({ url: 'http://127.0.0.1:8080', lastSeen: Date.now() });
        expect(withHeartbeat.success).toBe(false);

        const withTenant = EdgeSchema.safeParse({ url: 'http://127.0.0.1:8080', tenantId: 'org-1' });
        expect(withTenant.success).toBe(false);
    });
});

describe('edgeCrud', () => {
    it('is configured as unscoped internal infrastructure', () => {
        expect(edgeCrud.domain).toBe('edge');
        expect(edgeCrud.idField).toBe('id');
        expect(edgeCrud.scopedBy).toBeUndefined();
        expect(edgeCrud.dependencies).toEqual([]);
    });

    it('keeps all CRUD operations internal', () => {
        expect(edgeCrud.find.visibility).toBe('internal');
        expect(edgeCrud.findOne.visibility).toBe('internal');
        expect(edgeCrud.get.visibility).toBe('internal');
        expect(edgeCrud.create.visibility).toBe('internal');
        expect(edgeCrud.delete.visibility).toBe('internal');
    });
});
