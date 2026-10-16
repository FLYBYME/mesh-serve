import inspector from 'node:inspector';
import net from 'node:net';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IServiceContext } from '@flybyme/mesh';
import { INSPECT_PORT, inspectHere, podOf, reachCommands } from '../src/catalog/tools/nodeInspect.js';
import { createMockContext } from './unit/helpers/mockContext.js';

function ctxOf(): IServiceContext {
    return createMockContext().ctx;
}

/** Whether this machine's 9229 is free: an inspector tunnel open on it (as the owner's was, 10-16) is not a failure of the code. */
async function portFree(): Promise<boolean> {
    return new Promise((resolve) => {
        const probe = net.createServer();
        probe.once('error', () => resolve(false));
        probe.listen(INSPECT_PORT, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
}
const free = await portFree();

/** An address of this machine other than loopback, if it has one. */
function otherAddress(): string | undefined {
    return Object.values(os.networkInterfaces()).flat().find((a) => a !== undefined && a.family === 'IPv4' && !a.internal)?.address;
}

describe('a node\'s inspector (owner, 10-16: a debug websocket for profiling)', () => {
    afterEach(async () => {
        vi.useRealTimers();
        await inspectHere({ minutes: 1, close: true }, ctxOf());
    });

    it.skipIf(!free)('opens on 127.0.0.1 only, says how to reach it through a tunnel, and closes when asked (skipped while 9229 is taken here)', async () => {
        const opened = await inspectHere({ minutes: 5, close: false }, ctxOf());
        expect(opened.open).toBe(true);
        expect(opened.url).toMatch(new RegExp(`^ws://127\\.0\\.0\\.1:${INSPECT_PORT}/`));
        expect(opened.reach).toContain(`-L ${INSPECT_PORT}:127.0.0.1:${INSPECT_PORT}`);

        // DevTools' own discovery answers on loopback ...
        const list: unknown = await (await fetch(`http://127.0.0.1:${INSPECT_PORT}/json/list`)).json();
        expect(Array.isArray(list) && list.length > 0).toBe(true);
        // ... and nowhere else.
        const other = otherAddress();
        if (other !== undefined) {
            await expect(fetch(`http://${other}:${INSPECT_PORT}/json/list`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
        }

        const closed = await inspectHere({ minutes: 5, close: true }, ctxOf());
        expect(closed.open).toBe(false);
        expect(inspector.url()).toBeUndefined();
    });

    it.skipIf(!free)('closes by itself when its minutes are up', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        await inspectHere({ minutes: 2, close: false }, ctxOf());
        expect(inspector.url()).toBeDefined();

        vi.advanceTimersByTime(2 * 60_000 + 1);
        expect(inspector.url()).toBeUndefined();
    });

    it('knows it is in a pod by Kubernetes\' own variable, its namespace by POD_NAMESPACE (no service account mounted, 10-16)', () => {
        expect(podOf({}, 'laptop')).toBeUndefined();
        expect(podOf({ KUBERNETES_SERVICE_HOST: '10.17.0.1', POD_NAMESPACE: 'surfdns-system' }, 'mesh-edge1-edge-node-0'))
            .toEqual({ name: 'mesh-edge1-edge-node-0', namespace: 'surfdns-system' });
        expect(podOf({ KUBERNETES_SERVICE_HOST: '10.17.0.1' }, 'p')?.name).toBe('p');
    });

    it('in a pod, the tunnel goes through kubectl port-forward to that pod', () => {
        expect(reachCommands({ name: 'mesh-edge1-edge-node-0', namespace: 'surfdns-system' }))
            .toContain('sudo k3s kubectl -n surfdns-system port-forward pod/mesh-edge1-edge-node-0 9229:9229');
    });
});
