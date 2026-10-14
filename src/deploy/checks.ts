/**
 * What deploy checks before it changes anything: that what goes live is what was typechecked here,
 * against clients that still match their apis. The cluster builds from the remote, so the checkout
 * must be clean and on it; the kernel is built at the mesh-web tag the site was typechecked
 * against; and a generated client that no longer matches its api is the UI side's to regenerate
 * (owner, 10-14: "every time you make changes in a contract definition you must regenerate the ui
 * api.ts file") -- the server never refuses a deploy, so this does.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { describeApi } from '../cli/core/apiClient.js';
import { renderClient } from '../api/methods/generateClient.js';
import type { RepoSpec, SiteSpec } from './spec.js';

const run = promisify(execFile);

export interface Check {
    readonly ok: boolean;
    readonly said: string;
}

const pass = (said: string): Check => ({ ok: true, said });
const fail = (said: string): Check => ({ ok: false, said });

async function git(dir: string, ...args: string[]): Promise<string> {
    const { stdout } = await run('git', ['-C', dir, ...args]);

    return stdout.trim();
}

/** The checkout's own repo: the one the file marks `local`. */
export function localRepo(spec: SiteSpec): RepoSpec | undefined {
    return spec.repos.find((r) => r.local === true);
}

/** Clean, and HEAD is the remote branch's tip: the cluster builds that commit, not this disk. */
export async function checkout(dir: string, spec: SiteSpec): Promise<{ checks: Check[]; head: string | undefined }> {
    const repo = localRepo(spec);
    if (repo === undefined) return { checks: [pass('no repo is this checkout (local: true): nothing built from here')], head: undefined };

    const checks: Check[] = [];
    const dirty = await git(dir, 'status', '--porcelain');
    checks.push(dirty === '' ? pass('working tree clean') : fail('uncommitted changes: commit and push them'));

    await git(dir, 'fetch', '--quiet', 'origin', repo.ref);
    const head = await git(dir, 'rev-parse', 'HEAD');
    const remote = await git(dir, 'rev-parse', `origin/${repo.ref}`);
    checks.push(head === remote
        ? pass(`${head.slice(0, 7)} = origin/${repo.ref}`)
        : fail(`HEAD ${head.slice(0, 7)} is not origin/${repo.ref} ${remote.slice(0, 7)}: push, so what the cluster builds is what was typechecked`));

    return { checks, head };
}

const PackageJson = (value: unknown): Record<string, string> => {
    const deps: Record<string, string> = {};
    if (typeof value !== 'object' || value === null) return deps;

    for (const field of ['dependencies', 'devDependencies']) {
        const listed: unknown = Reflect.get(value, field);
        if (typeof listed !== 'object' || listed === null) continue;
        for (const [name, version] of Object.entries(listed)) {
            if (typeof version === 'string') deps[name] = version;
        }
    }

    return deps;
};

/** The kernel builds at the mesh-web tag package.json pins, and that tag is on the remote. */
export async function kernel(dir: string, spec: SiteSpec): Promise<Check[]> {
    const repo = spec.repos.find((r) => r.kernel === true);
    const part = spec.parts.find((p) => p.kind === 'kernel');
    if (repo === undefined || part === undefined) return [fail('no kernel: a repo with kernel: true and a kind: kernel part')];

    const ref = part.ref ?? repo.ref;
    const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf-8').catch(() => undefined);
    const pinned = raw === undefined ? undefined : PackageJson(JSON.parse(raw))['@flybyme/mesh-web']?.split('#')[1];

    const checks: Check[] = [];
    if (pinned !== undefined) {
        checks.push(pinned === ref
            ? pass(`kernel at ${ref}, the mesh-web tag package.json pins`)
            : fail(`the kernel builds at ${ref} but package.json pins mesh-web ${pinned}: make them the same`));
    }

    const { stdout } = await run('git', ['ls-remote', repo.url, `refs/tags/${ref}`, `refs/heads/${ref}`]);
    checks.push(stdout.trim() !== '' ? pass(`${ref} is on ${repo.url}`) : fail(`${ref} is not on ${repo.url}: push it`));

    return checks;
}

const STAMPED = /shapeHash: "([0-9a-f]{64})"/;

/** Where an api host's description is: the CLI's own api when it is that host, else https. */
function describeUrl(host: string, currentUrl: string, currentHost: string): string {
    if (host === currentHost) return currentUrl;

    return `https://${host}`;
}

/**
 * Each generated client still matches its api (the shape hash stamped in it against the api's
 * own). With `regenerate`, a stale one is written again from the api instead -- the typecheck
 * after it then says whether the site still compiles.
 */
export async function clients(dir: string, spec: SiteSpec, current: { url: string; host: string }, regenerate: boolean): Promise<Check[]> {
    const checks: Check[] = [];

    for (const client of spec.clients) {
        const host = client.api ?? spec.api.host;
        const file = path.join(dir, client.file);
        const source = await fs.readFile(file, 'utf-8').catch(() => undefined);
        if (source === undefined) {
            checks.push(fail(`${client.file} is missing: mesh-serve generate --host ${host} --out ${client.file}`));
            continue;
        }

        const stamped = STAMPED.exec(source)?.[1];
        const outcome = await describeApi(describeUrl(host, current.url, current.host))
            .then((descriptor) => ({ descriptor }), (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
        if ('error' in outcome) {
            checks.push(fail(`${host} cannot be described: ${outcome.error}`));
            continue;
        }

        const described = outcome.descriptor;

        if (stamped === described.shapeHash) {
            checks.push(pass(`${client.file} matches ${host}`));
            continue;
        }

        if (regenerate) {
            await fs.writeFile(file, renderClient(described.host, described));
            // Not a pass: the new file is not committed, so what the cluster would build differs from it.
            checks.push(fail(`${client.file} regenerated from ${host}: typecheck, commit and push it, then deploy again`));
            continue;
        }

        checks.push(fail(`${client.file} no longer matches ${host}: mesh-serve generate --host ${host} --out ${client.file} (or deploy --regenerate)`));
    }

    return checks;
}

/** The file's typecheck command, its output shown as it runs. */
export async function typecheck(dir: string, spec: SiteSpec): Promise<Check> {
    const [command, ...args] = spec.typecheck;
    if (command === undefined) return fail('no typecheck command');

    const result = await run(command, args, { cwd: dir, maxBuffer: 32 * 1024 * 1024 }).then(() => undefined, (err: unknown) => err);
    if (result === undefined) return pass('typechecks');

    const said = typeof result === 'object' && result !== null && 'stdout' in result && typeof result.stdout === 'string' ? result.stdout : String(result);

    return fail(`does not typecheck:\n${said.trim().split('\n').slice(0, 20).join('\n')}`);
}
