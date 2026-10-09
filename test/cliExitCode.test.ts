import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
// A home of its own: no session, so nothing is asked of any api.
const home = mkdtempSync(path.join(os.tmpdir(), 'mesh-serve-cli-'));

function cli(...args: string[]) {
    return spawnSync(path.join(ROOT, 'node_modules/.bin/tsx'), [path.join(ROOT, 'src/cli/index.ts'), ...args], {
        env: { ...process.env, HOME: home }, encoding: 'utf-8', timeout: 60_000,
    });
}

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('the CLI\'s exit code', () => {
    it('is 1 for a command the api does not have, so a script stops (2026-10-09: processGroup.get exited 0)', () => {
        const r = cli('processGroup.nosuch', '--id', 'x');
        expect(r.stderr).toContain("unknown command 'processGroup.nosuch'");
        expect(r.status).toBe(1);
    });

    it('is 1 for an unknown option on a built-in', () => {
        expect(cli('login', '--nosuch').status).toBe(1);
    });

    it('is 0 for --help', () => {
        const r = cli('--help');
        expect(r.stdout).toContain('mesh-serve');
        expect(r.status).toBe(0);
    });
}, 120_000);
