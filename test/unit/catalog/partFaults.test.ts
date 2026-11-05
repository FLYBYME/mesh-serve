import { afterEach, describe, expect, it } from 'vitest';

import { clearServiceRunning, markServiceRunning, partInStack } from '../../../src/catalog/methods/services.js';
import { createFaultHandler, type FaultIsolationOptions } from '../../../src/catalog/methods/partFaults.js';

const NODE = 'fault-node';
const SSH = '/home/node/.mesh/artifacts/7cda86ae/register.cjs';
const DNS = '/home/node/.mesh/artifacts/7cda86aebb/register.cjs';

/** The frames 11-05's crash had: ssh2's cleanup inside the door's own bundle, on a socket's close. */
function crashIn(modulePath: string): Error {
    const err = new TypeError("Cannot set properties of undefined (setting 'state')");
    err.stack = [
        `TypeError: ${err.message}`,
        `    at vh (${modulePath}:14:55508)`,
        `    at wc.cleanup (${modulePath}:14:57390)`,
        '    at Object.onceWrapper (node:events:634:26)',
        '    at TCP.<anonymous> (node:net:347:12)',
    ].join('\n');

    return err;
}

interface Recorded {
    readonly calls: Array<{ tool: string; params: Record<string, unknown>; nodeID?: string; tenant?: unknown }>;
    readonly exits: number[];
    readonly errors: string[];
}

function harness(stop: () => Promise<unknown> = () => Promise.resolve({ stopped: true })): { options: FaultIsolationOptions; seen: Recorded } {
    const seen: Recorded = { calls: [], exits: [], errors: [] };
    const options: FaultIsolationOptions = {
        nodeID: NODE,
        broker: {
            callNamed: (tool, params, opts) => {
                seen.calls.push({ tool, params, ...(opts?.nodeID !== undefined ? { nodeID: opts.nodeID } : {}), tenant: opts?.meta?.tenant_id });
                return stop();
            },
        },
        logger: { error: (m) => { seen.errors.push(m); }, info: () => undefined },
        exit: (code) => { seen.exits.push(code); },
    };

    return { options, seen };
}

const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

afterEach(() => {
    for (const id of ['ssh', 'dns', 'core:api']) clearServiceRunning(NODE, id);
});

describe('which part a stack runs through', () => {
    it('names the part whose own folder a frame is in', () => {
        markServiceRunning(NODE, 'ssh', 'ssh', SSH, 'a1', 'org-1');
        markServiceRunning(NODE, 'dns', 'dns', DNS, 'a2', 'org-1');

        expect(partInStack(NODE, crashIn(SSH).stack ?? '')?.partId).toBe('ssh');
        expect(partInStack(NODE, crashIn(DNS).stack ?? '')?.partId).toBe('dns');
    });

    it('a folder is matched whole: one hash that starts another is not it', () => {
        markServiceRunning(NODE, 'dns', 'dns', DNS, 'a2', 'org-1');

        expect(partInStack(NODE, crashIn(SSH).stack ?? '')).toBeUndefined();
    });

    it('the frame nearest the throw decides, when a part called another', () => {
        markServiceRunning(NODE, 'ssh', 'ssh', SSH, 'a1', 'org-1');
        markServiceRunning(NODE, 'dns', 'dns', DNS, 'a2', 'org-1');
        const stack = [`Error: x`, `    at a (${DNS}:1:1)`, `    at b (${SSH}:1:1)`].join('\n');

        expect(partInStack(NODE, stack)?.partId).toBe('dns');
    });

    it('never names a core part, or another node\'s', () => {
        markServiceRunning(NODE, 'core:api', 'serve.api', SSH);
        markServiceRunning('other-node', 'ssh', 'ssh', SSH, 'a1', 'org-1');

        expect(partInStack(NODE, crashIn(SSH).stack ?? '')).toBeUndefined();
        clearServiceRunning('other-node', 'ssh');
    });
});

describe('a part\'s uncaught exception', () => {
    it('stops that part on this node, in its organization, and the node carries on', async () => {
        markServiceRunning(NODE, 'ssh', 'ssh', SSH, 'a1', 'org-1');
        const { options, seen } = harness();

        const outcome = createFaultHandler(options)(crashIn(SSH), 'uncaughtException');
        await settle();

        expect(outcome.kind).toBe('stopping');
        expect(seen.calls).toEqual([{ tool: 'serve.part.stop', params: { id: 'ssh' }, nodeID: NODE, tenant: 'org-1' }]);
        expect(seen.exits).toEqual([]);
    });

    it('stops it once while it unwinds, and again for a later fault', async () => {
        markServiceRunning(NODE, 'ssh', 'ssh', SSH, 'a1', 'org-1');
        const { options, seen } = harness();
        const handle = createFaultHandler(options);

        expect(handle(crashIn(SSH), 'uncaughtException').kind).toBe('stopping');
        expect(handle(crashIn(SSH), 'unhandledRejection').kind).toBe('already-stopping');
        await settle();
        expect(handle(crashIn(SSH), 'uncaughtException').kind).toBe('stopping');

        expect(seen.calls).toHaveLength(2);
        expect(seen.exits).toEqual([]);
    });

    it('ends the node, as Node would, when no part is in the stack', () => {
        markServiceRunning(NODE, 'ssh', 'ssh', SSH, 'a1', 'org-1');
        const { options, seen } = harness();
        const own = new Error('mesh-serve itself');
        own.stack = 'Error: mesh-serve itself\n    at x (/app/node_modules/@flybyme/mesh-serve/dist/x.js:1:1)';

        expect(createFaultHandler(options)(own, 'uncaughtException').kind).toBe('exit');
        expect(seen.exits).toEqual([1]);
        expect(seen.calls).toEqual([]);
        expect(seen.errors[0]).toContain('mesh-serve itself');
    });

    it('ends the node when the part cannot be stopped', async () => {
        markServiceRunning(NODE, 'ssh', 'ssh', SSH, 'a1', 'org-1');
        const { options, seen } = harness(() => Promise.reject(new Error('stop refused')));

        createFaultHandler(options)(crashIn(SSH), 'uncaughtException');
        await settle();

        expect(seen.exits).toEqual([1]);
    });

    it('a thrown non-Error is still read, and with no part ends the node', () => {
        const { options, seen } = harness();

        expect(createFaultHandler(options)('a string', 'unhandledRejection').kind).toBe('exit');
        expect(seen.exits).toEqual([1]);
    });
});
