import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { IServiceContext } from '@flybyme/mesh';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'labels-test-'));
process.env['HOME'] = home;
const { labelHas } = await import('../../../src/catalog/methods/resolveNode.js');
const { LABELS_FILE, readSavedLabels, saveLabels } = await import('../../../src/catalog/methods/labels.js');
const { labelHere } = await import('../../../src/catalog/tools/nodeLabel.js');

afterAll(async () => { await fs.rm(home, { recursive: true, force: true }); });

describe('roles: a label can carry several values', () => {
    it('matches any value of a comma list, and a single value exactly as before', () => {
        expect(labelHas('dns,control-plane', 'control-plane')).toBe(true);
        expect(labelHas('dns, control-plane', 'dns')).toBe(true);
        expect(labelHas('dns', 'dns')).toBe(true);
        expect(labelHas('dns', 'dn')).toBe(false);
        expect(labelHas('control-plane', 'control')).toBe(false);
        expect(labelHas(undefined, 'dns')).toBe(false);
    });
});

describe('labels saved across restarts', () => {
    it('reads what was saved, and ignores anything malformed', async () => {
        expect(readSavedLabels()).toEqual({});
        await saveLabels({ role: 'dns,control-plane', region: 'bhs' });
        expect(readSavedLabels()).toEqual({ role: 'dns,control-plane', region: 'bhs' });
        await fs.writeFile(LABELS_FILE, JSON.stringify({ role: 'dns', 'bad key!': 'x', n: 5 }));
        expect(readSavedLabels()).toEqual({ role: 'dns' });
        await fs.writeFile(LABELS_FILE, 'not json');
        expect(readSavedLabels()).toEqual({});
    });
});

describe('the parts label: what a node runs of the core parts', () => {
    const known = ['identity', 'cdn', 'hold', 'queue', 'api'] as const;

    it('replaces the boot flag when present, drops what it does not know, absent means the flag', async () => {
        const { partsFromLabels } = await import('../../../src/catalog/methods/labels.js');
        expect(partsFromLabels({ parts: 'api,cdn' }, known)).toEqual(['api', 'cdn']);
        expect(partsFromLabels({ parts: 'queue, bogus,queue' }, known)).toEqual(['queue']);
        expect(partsFromLabels({ parts: '' }, known)).toEqual([]);
        expect(partsFromLabels({ role: 'dns' }, known)).toBeUndefined();
    });
});

describe('serve.node.label on the node itself', () => {
    const ctxWith = (metadata: Record<string, string>) => {
        const setLocalMetadata = vi.fn();
        const ctx = {
            nodeID: 'ns1',
            broker: { registry: { getNode: () => ({ metadata }), setLocalMetadata } },
            logger: { info: vi.fn() },
        } as unknown as IServiceContext;
        return { ctx, setLocalMetadata };
    };

    it('sets and removes labels live, and saves them', async () => {
        const { ctx, setLocalMetadata } = ctxWith({ role: 'dns', region: 'bhs', provider: 'ovh' });
        const out = await labelHere({ set: { role: 'dns,control-plane' }, remove: ['provider'] }, ctx);
        expect(out).toEqual({ nodeID: 'ns1', labels: { role: 'dns,control-plane', region: 'bhs' } });
        expect(setLocalMetadata).toHaveBeenCalledWith({ role: 'dns,control-plane', region: 'bhs' });
        expect(readSavedLabels()).toEqual({ role: 'dns,control-plane', region: 'bhs' });
    });

    it('a parts change loads what is new before unloading what is gone', async () => {
        const { markServiceRunning, clearServiceRunning } = await import('../../../src/catalog/methods/services.js');
        markServiceRunning('ns1', 'core:queue', 'serve.queue');
        const calls: string[] = [];
        const ctx = {
            nodeID: 'ns1',
            broker: { registry: { getNode: () => ({ metadata: { role: 'dns', parts: 'queue' } }), setLocalMetadata: vi.fn() } },
            logger: { info: vi.fn() },
            call: vi.fn(async (action: string, input: { name: string }) => { calls.push(`${action} ${input.name}`); return {}; }),
        } as unknown as IServiceContext;
        await labelHere({ set: { parts: 'api,cdn' }, remove: [] }, ctx);
        expect(calls).toEqual(['serve.corePart.load api', 'serve.corePart.load cdn', 'serve.corePart.unload queue']);
        clearServiceRunning('ns1', 'core:queue');
    });

    it('refuses a label that is not one', async () => {
        const { ctx, setLocalMetadata } = ctxWith({});
        await expect(labelHere({ set: { 'role;rm': 'x' }, remove: [] }, ctx)).rejects.toThrow(/Not a label/);
        expect(setLocalMetadata).not.toHaveBeenCalled();
    });
});
