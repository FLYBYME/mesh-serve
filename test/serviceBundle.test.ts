/**
 * A service bundle has to *load*, not just build. Two ways real npm dependencies broke that, both
 * found building surfdns services for the live cluster:
 *
 *  - a CommonJS dependency calling `require('crypto')` (acme-client, in surfdns-certs): the bundle
 *    is an ES module, which has no `require`, and esbuild's stand-in threw "Dynamic require of
 *    \"crypto\" is not supported" as soon as it was imported;
 *  - a dependency that optionally loads a native addon (ssh2 -> cpu-features' `*.node`, in
 *    surfdns-ssh): machine code cannot be bundled, and the build failed at resolve time.
 *
 * Built with the builder's own esbuild settings, then imported from a directory with no
 * package.json above it -- the way serve.part.start imports from ~/.mesh/artifacts/<hash>/.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runEsbuild } from '../src/catalog/methods/build.js';

let fixture: string;
let out: string;

async function write(file: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
}

beforeAll(async () => {
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-service-bundle-src-'));
    // No package.json anywhere above the output, exactly as under ~/.mesh/artifacts.
    out = await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-service-bundle-out-'));

    // A CommonJS package that requires a node builtin, as acme-client does.
    await write(path.join(fixture, 'node_modules/cjs-uses-builtin/package.json'), JSON.stringify({ name: 'cjs-uses-builtin', main: 'index.js' }));
    await write(path.join(fixture, 'node_modules/cjs-uses-builtin/index.js'),
        "const crypto = require('crypto');\nmodule.exports = { digest: (s) => crypto.createHash('sha256').update(s).digest('hex') };\n");

    // A package whose entry is a native addon, as cpu-features is -- and one that loads it
    // optionally, inside try/catch, as ssh2 does.
    await write(path.join(fixture, 'node_modules/native-addon/package.json'), JSON.stringify({ name: 'native-addon', main: 'index.js' }));
    await write(path.join(fixture, 'node_modules/native-addon/index.js'), "module.exports = require('./build/Release/addon.node');\n");
    await write(path.join(fixture, 'node_modules/optional-native/package.json'), JSON.stringify({ name: 'optional-native', main: 'index.js' }));
    await write(path.join(fixture, 'node_modules/optional-native/index.js'),
        "let native = null;\ntry { native = require('native-addon'); } catch { native = null; }\nmodule.exports = { usingNative: () => native !== null };\n");

    // A CommonJS package that reads __dirname at load, as ssh2 does.
    await write(path.join(fixture, 'node_modules/cjs-uses-dirname/package.json'), JSON.stringify({ name: 'cjs-uses-dirname', main: 'index.js' }));
    await write(path.join(fixture, 'node_modules/cjs-uses-dirname/index.js'), 'const here = __dirname;\nmodule.exports = { here: () => here };\n');

    await write(path.join(fixture, 'src/register.ts'), [
        "import builtin from 'cjs-uses-builtin';",
        "import dirnameUser from 'cjs-uses-dirname';",
        "import optional from 'optional-native';",
        'export const digest = (s: string): string => builtin.digest(s);',
        'export const here = (): string => dirnameUser.here();',
        'export const usingNative = (): boolean => optional.usingNative();',
        "export async function register(): Promise<string> { return 'fixture'; }",
        'export default register;',
        '',
    ].join('\n'));
});

afterAll(async () => {
    await fs.rm(fixture, { recursive: true, force: true });
    await fs.rm(out, { recursive: true, force: true });
});

describe('a service bundle built by runEsbuild', () => {
    it('builds, although a dependency references a native addon', async () => {
        await runEsbuild([path.join(fixture, 'src/register.ts')], out, ['@flybyme/mesh'], 'node');
        await expect(fs.access(path.join(out, 'register.js'))).resolves.toBeUndefined();
    });

    it('loads and runs a CommonJS dependency that requires a node builtin', async () => {
        const mod: unknown = await import(path.join(out, 'register.js'));
        expect(mod).toHaveProperty('digest');
        if (typeof mod !== 'object' || mod === null || !('digest' in mod) || typeof mod.digest !== 'function') throw new Error('no digest export');
        expect(mod.digest('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    it("gives a CommonJS dependency a __dirname: the bundle's own directory", async () => {
        const mod: unknown = await import(path.join(out, 'register.js'));
        if (typeof mod !== 'object' || mod === null || !('here' in mod) || typeof mod.here !== 'function') throw new Error('no here export');
        expect(mod.here()).toBe(out);
    });

    it('falls back cleanly when the optional native addon is not there', async () => {
        const mod: unknown = await import(path.join(out, 'register.js'));
        if (typeof mod !== 'object' || mod === null || !('usingNative' in mod) || typeof mod.usingNative !== 'function') throw new Error('no usingNative export');
        expect(mod.usingNative()).toBe(false);
    });
});
