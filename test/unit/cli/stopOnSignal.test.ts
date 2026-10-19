import { afterEach, describe, expect, it } from 'vitest';
import { stopOnSignal } from '../../../src/cli/core/stopOnSignal.js';

/** Node is PID 1 in a mesh pod: without a handler a stop waited 30 s and was killed (10-16). */
describe('a node told to stop', () => {
    const said: string[] = [];
    const logger = {
        info: (m: string) => { said.push(m); },
        warn: (m: string) => { said.push(m); },
        error: (m: string) => { said.push(m); },
    };

    afterEach(() => {
        said.length = 0;
        process.removeAllListeners('SIGTERM');
        process.removeAllListeners('SIGINT');
    });

    it('stops on SIGTERM and exits 0, once, however many signals come', async () => {
        let stops = 0;
        const exits: number[] = [];
        stopOnSignal({ stop: async () => { stops += 1; } }, logger, 1000, (code) => { exits.push(code); });

        process.emit('SIGTERM', 'SIGTERM');
        process.emit('SIGINT', 'SIGINT');
        await new Promise((r) => setTimeout(r, 10));

        expect(stops).toBe(1);
        expect(exits).toEqual([0]);
        expect(said[0]).toBe('SIGTERM: stopping this node.');
    });

    it('exits 1 when the teardown fails, saying why', async () => {
        const exits: number[] = [];
        stopOnSignal({ stop: async () => { throw new Error('database gone'); } }, logger, 1000, (code) => { exits.push(code); });

        process.emit('SIGINT', 'SIGINT');
        await new Promise((r) => setTimeout(r, 10));

        expect(exits).toEqual([1]);
        expect(said).toContain('Stopping failed: database gone');
    });

    it('exits 1 when the teardown never finishes', async () => {
        const exits: number[] = [];
        stopOnSignal({ stop: () => new Promise<void>(() => undefined) }, logger, 50, (code) => { exits.push(code); });

        process.emit('SIGTERM', 'SIGTERM');
        await new Promise((r) => setTimeout(r, 100));

        expect(exits).toEqual([1]);
        expect(said).toContain('Not stopped within 50 ms: exiting anyway.');
    });
});
