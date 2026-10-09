import { describe, expect, it } from 'vitest';
import { isLoopback } from '../src/cli/commands/start.js';

/**
 * A node started on loopback keeps its api and cdn there (start sets SERVER_HOST): install.sh's
 * pass 1 left an unclaimed node's api answering every address (the stand-up check, 2026-10-08).
 */
describe('which --host keeps the api and cdn on loopback', () => {
    it('is loopback: 127.0.0.0/8, ::1, localhost', () => {
        for (const host of ['127.0.0.1', '127.1.2.3', '::1', 'localhost']) expect(isLoopback(host)).toBe(true);
    });

    it('is not: a wildcard, a fleet address, a public one', () => {
        for (const host of ['0.0.0.0', '::', '10.10.0.5', '167.172.146.21', '127.0.0.1.example.com']) expect(isLoopback(host)).toBe(false);
    });
});
