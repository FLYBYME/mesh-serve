import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Rebuilding a lost build (methods/pullArtifact.ts) is only safe if the builder makes the same
 * bytes from the same commit: a release names its builds by hash. The real builder, twice, on the
 * same commit, from two separate checkouts -- as two machines would. It runs in a plain node
 * process (tsx) with its own home directory: the builder uses import.meta.resolve, which vitest's
 * module transform does not provide, and its folders hang off the home directory.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('the builder is reproducible', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reproducible-home-'));
    afterAll(() => { fs.rmSync(home, { recursive: true, force: true }); });

    it('builds the same commit to the same hash twice, from separate checkouts', () => {
        const repo = path.join(home, 'repo');
        fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'package.json'), '{ "name": "repro", "version": "1.0.0", "type": "module" }\n');
        fs.writeFileSync(path.join(repo, 'src', 'register.ts'),
            'import type { IServiceBroker } from "@flybyme/mesh";\n'
            + 'const greeting = (name: string): string => `hello ${name}`;\n'
            + 'export async function register(_b: IServiceBroker): Promise<string> { return greeting("repro"); }\n'
            + 'export default register;\n');
        const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
        git('init', '-q', '-b', 'master');
        git('add', '-A');
        git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one');
        const commit = git('rev-parse', 'HEAD');

        const script = path.join(home, 'build-twice.mts');
        fs.writeFileSync(script,
            `import { buildService } from ${JSON.stringify(path.join(ROOT, 'src/catalog/methods/build.ts'))};\n`
            + `const part = { path: '.', entryPoint: 'src/register.ts' };\n`
            + `const url = ${JSON.stringify(`file://${repo}`)};\n`
            + `const first = await buildService(part, { id: 'machine-one', url }, ${JSON.stringify(commit)});\n`
            + `const second = await buildService(part, { id: 'machine-two', url }, ${JSON.stringify(commit)});\n`
            + `console.log(JSON.stringify({ first, second }));\n`);
        const out = execFileSync(path.join(ROOT, 'node_modules/.bin/tsx'), [script], {
            cwd: ROOT, encoding: 'utf-8', env: { ...process.env, HOME: home },
        });
        const { first, second } = JSON.parse(out.trim().split('\n').pop() ?? '{}') as {
            first: { hash: string; commit: string; assets: unknown[] }; second: { hash: string; assets: unknown[] };
        };

        expect(first.commit).toBe(commit);
        expect(second.hash).toBe(first.hash);
        expect(second.assets).toEqual(first.assets);
    }, 120000);
});
