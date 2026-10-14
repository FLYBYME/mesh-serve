import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { apiExportName } from '../src/api/methods/generateClient.js';
import { checkout, clients } from '../src/deploy/checks.js';
import { loadSite, siteSpecSchema } from '../src/deploy/spec.js';
import { starterFiles, writeStarter } from '../src/deploy/starter.js';

const WARGAME = `
site: wargame.localhost
org: platform
api:
  host: wargame-api.localhost
  expose:
    - contract: identity.whoami
      gate: public
    - { contract: wargame.match.create, gate: { role: operator } }
repos:
  - name: mesh-web
    url: https://github.com/FLYBYME/mesh-web
    ref: v0.21.10
    kernel: true
  - name: wargame
    url: https://github.com/FLYBYME/wargame
    ref: main
parts:
  - repo: mesh-web
    key: platform/kernel
    kind: kernel
    entry: src/index.ts
    imports: '@flybyme/mesh-web'
  - repo: wargame
    key: platform/wargame-site
    kind: application
    entry: src/site/app.ts
policy:
  window-manager/mode: single
`;

function tmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('a site file', () => {
    it('loads one written for sync (the wargame site) as it is, with deploy\'s fields defaulted', () => {
        const dir = tmp('site-');
        const file = path.join(dir, 'wargame.site.yaml');
        fs.writeFileSync(file, WARGAME);

        const spec = loadSite(file);

        expect(spec.site).toBe('wargame.localhost');
        expect(spec.pages).toEqual([]);
        expect(spec.clients).toEqual([]);
        expect(spec.indexable).toBe(false);
        expect(spec.typecheck).toEqual(['npx', 'tsc', '-p', 'tsconfig.json', '--noEmit']);
    });

    it('leaves `expose` out when the file does: absent leaves the api\'s rows alone, [] would remove them all', () => {
        const spec = siteSpecSchema.parse({ site: 'x.test', api: { host: 'api.x.test' }, repos: [], parts: [] });

        expect(spec.api.expose).toBeUndefined();
    });

    it('refuses an exposure with no gate, naming the field', () => {
        const parsed = siteSpecSchema.safeParse({
            site: 'x.test', api: { host: 'api.x.test', expose: [{ contract: 'a.b' }] }, repos: [], parts: [],
        });

        expect(parsed.success).toBe(false);
        expect(parsed.error?.issues[0]?.path).toEqual(['api', 'expose', 0, 'gate']);
    });
});

describe('the starter init writes into an empty repository', () => {
    const files = starterFiles({
        name: 'new-site', title: 'New site', apiHost: 'api.one-host.ca', apiExport: apiExportName('api.one-host.ca'),
        meshWebTag: 'v0.21.11', kitTag: 'v0.1.11',
    });

    it('pins mesh-web and the kit to the tags it was given, and wires the App to the generated client by its name', () => {
        const pkg: unknown = JSON.parse(files.get('package.json') ?? '{}');

        expect(JSON.stringify(pkg)).toContain('github:FLYBYME/mesh-web#v0.21.11');
        expect(JSON.stringify(pkg)).toContain('github:FLYBYME/mesh-web-kit#v0.1.11');
        expect(apiExportName('api.one-host.ca')).toBe('apiOneHostCaApi');
        expect(files.get('src/index.ts')).toContain("import { apiOneHostCaApi } from './generated/api.js';");
        expect([...files.keys()].sort()).toEqual(['.gitignore', 'package.json', 'src/home-view.ts', 'src/index.ts', 'tsconfig.json']);
    });

    it('never overwrites a file that is there', async () => {
        const dir = tmp('starter-');
        fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "mine" }');

        const written = await writeStarter(dir, files);

        expect(written).not.toContain('package.json');
        expect(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')).toBe('{ "name": "mine" }');
    });
});

describe('the checkout check', () => {
    let work: string;

    beforeAll(() => {
        const origin = tmp('origin-');
        execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin]);
        work = tmp('work-');
        execFileSync('git', ['clone', '-q', origin, work]);
        execFileSync('git', ['-C', work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one']);
        execFileSync('git', ['-C', work, 'push', '-q', 'origin', 'HEAD:main']);
    });

    const spec = siteSpecSchema.parse({
        site: 'x.test', api: { host: 'api.x.test' },
        repos: [{ name: 'x', url: 'https://example.test/x', ref: 'main', local: true }], parts: [],
    });

    it('passes a clean checkout at its remote\'s tip, and says the commit', async () => {
        const { checks, head } = await checkout(work, spec);

        expect(checks.every((c) => c.ok)).toBe(true);
        expect(head).toMatch(/^[0-9a-f]{40}$/);
    });

    it('refuses uncommitted changes, and a commit not on the remote', async () => {
        fs.writeFileSync(path.join(work, 'new.txt'), 'x');
        const dirty = await checkout(work, spec);
        expect(dirty.checks.find((c) => !c.ok)?.said).toMatch(/uncommitted/);

        execFileSync('git', ['-C', work, 'add', '.']);
        execFileSync('git', ['-C', work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'two']);
        const ahead = await checkout(work, spec);
        expect(ahead.checks.find((c) => !c.ok)?.said).toMatch(/is not origin\/main/);
    });
});

describe('the clients check', () => {
    const SHAPE = 'a'.repeat(64);
    let server: http.Server;
    let url: string;

    beforeAll(async () => {
        server = http.createServer((_req, res) => {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ host: 'api.x.test', base: '/api', exposure: 'e'.repeat(64), shapeHash: SHAPE, calls: [], events: [] }));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address: AddressInfo | string | null = server.address();
        if (address === null || typeof address === 'string') throw new Error('no port');
        url = `http://127.0.0.1:${address.port}`;
    });

    afterAll(() => {
        server.close();
    });

    const spec = siteSpecSchema.parse({
        site: 'x.test', api: { host: 'api.x.test' }, clients: [{ file: 'src/generated/api.ts' }], repos: [], parts: [],
    });

    function withClient(shapeHash: string): string {
        const dir = tmp('client-');
        fs.mkdirSync(path.join(dir, 'src/generated'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'src/generated/api.ts'), `export const api = defineApi({\n    shapeHash: "${shapeHash}",\n});\n`);

        return dir;
    }

    it('passes a client stamped with its api\'s current shape', async () => {
        const checks = await clients(withClient(SHAPE), spec, { url, host: 'api.x.test' }, false);

        expect(checks).toEqual([{ ok: true, said: 'src/generated/api.ts matches api.x.test' }]);
    });

    it('refuses a stale one, saying how to regenerate it', async () => {
        const checks = await clients(withClient('b'.repeat(64)), spec, { url, host: 'api.x.test' }, false);

        expect(checks[0]?.ok).toBe(false);
        expect(checks[0]?.said).toContain('mesh-serve generate --host api.x.test --out src/generated/api.ts');
    });

    it('with --regenerate writes it again from the api, and still stops: the new file is not committed', async () => {
        const dir = withClient('b'.repeat(64));
        const checks = await clients(dir, spec, { url, host: 'api.x.test' }, true);

        expect(checks[0]?.ok).toBe(false);
        expect(fs.readFileSync(path.join(dir, 'src/generated/api.ts'), 'utf-8')).toContain(SHAPE);
    });
});
