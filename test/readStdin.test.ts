/**
 * `--json -`: a call's whole input from stdin, so a secret (vaultSecret.seal) is never an argument
 * -- never in the process list or shell history.
 */
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { readStdin } from '../src/cli/core/dynamicCommands.js';

describe('readStdin', () => {
    it('reads every chunk, as text or bytes', async () => {
        const text = await readStdin(Readable.from(['{"name":', Buffer.from('"a",'), '"secret":"s"}']));
        expect(JSON.parse(text)).toEqual({ name: 'a', secret: 's' });
    });

    it('is empty for an empty stdin', async () => {
        expect(await readStdin(Readable.from([]))).toBe('');
    });
});
