import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localFolder } from '../../../src/cli/commands/artifact.js';

/**
 * artifact-build keys its checkout by `--repo`: a folder on this machine counts by its absolute
 * path, so `--repo .` from two folders is two checkouts, not one reused.
 */
describe('artifact-build --repo', () => {
    it('a folder is its absolute path, whichever way it was written', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-repo-'));
        try {
            expect(await localFolder(dir)).toBe(dir);
            expect(await localFolder(path.relative(process.cwd(), dir))).toBe(dir);
            expect(await localFolder('.')).toBe(process.cwd());
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('a remote stays as written', async () => {
        expect(await localFolder('https://git.surfdns.net/org/mesh.git')).toBeUndefined();
        expect(await localFolder('git@github.com:FLYBYME/mesh.git')).toBeUndefined();
        expect(await localFolder('/no/such/folder/here')).toBeUndefined();
    });
});
