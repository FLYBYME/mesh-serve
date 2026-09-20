import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';
import { z } from 'zod';

import type { Part } from '../contracts/part.contract.js';
import type { Repo } from '../contracts/repo.contract.js';
import { artifactAssetSchema } from '../schema/artifact.js';
import { artifactDir } from './artifacts.js';

const execFileAsync = promisify(execFile);

export const repoWorkdir = path.join(os.homedir(), '.mesh', 'repos');

type ArtifactAssetInput = z.infer<typeof artifactAssetSchema>;

async function exists(p: string): Promise<boolean> {
    return fs.stat(p).then(() => true, () => false);
}

async function git(args: string[], cwd?: string): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout;
}

/**
 * A part's real npm dependencies (mesh-operator's generated client imports real `zod`) were
 * unresolvable at build time -- the checkout is a fresh clone, never `npm install`ed, so esbuild
 * had nothing to bundle and nothing to mark external. Fixed the same way the git checkout itself
 * is handled: `npm ci`/`install` runs once per checkout dir, then `node_modules` is reused across
 * builds of the same repo exactly like the git history already is, rather than a mesh part or a
 * blessed-package allowlist -- an ordinary npm dependency is bundled by esbuild the ordinary way
 * the moment it can actually resolve it.
 *
 * `npm ci` when there's a lockfile (deterministic, and it also removes anything stale left over
 * from a previous ref's dependency set); `npm install` otherwise, since `ci` refuses to run
 * without one. Skipped entirely when there's no `package.json` -- most parts have no npm
 * dependencies of their own at all, and installing nothing should cost nothing.
 */
async function ensureNpmInstall(dir: string): Promise<void> {
    if (!(await exists(path.join(dir, 'package.json')))) return;
    const hasLockfile = await exists(path.join(dir, 'package-lock.json'));
    // --omit=dev: esbuild only ever resolves what the entry point actually imports, and a repo's
    // dev tooling is exactly the kind of thing that assumes a full working checkout -- a sibling
    // `file:../mesh-serve` devDependency, real in a normal clone, has no "sibling" in this builder's
    // isolated per-repo workdir (~/.mesh/repos/<repoId>) and fails `npm ci` outright before esbuild
    // ever runs, for a package the build was never going to import anyway.
    // --ignore-scripts: omitting devDependencies broke a *different* repo the first time this ran
    // for real against one -- mesh-web's own package.json has `"prepare": "npm run build"` (tsc,
    // producing its own dist/), which `npm ci` runs automatically and which then fails outright
    // ("tsc: not found") because tsc is itself a devDependency this just omitted. esbuild bundles
    // straight from source (entryPoint is always a .ts file under src/, never a repo's own dist/),
    // so no lifecycle script's output was ever going to be used regardless of whether it succeeded.
    await execFileAsync('npm', [hasLockfile ? 'ci' : 'install', '--no-audit', '--no-fund', '--omit=dev', '--ignore-scripts'], {
        cwd: dir,
        // npm's own install log easily clears the default 1MB maxBuffer on a real dependency tree;
        // this only needs to not throw, the output itself is never read.
        maxBuffer: 1024 * 1024 * 50,
    });
}

/**
 * Clones a repo on first use, otherwise fetches; either way leaves the workdir checked out at ref
 * with its own npm dependencies installed. The workdir is reused across builds of the same repo --
 * it is builder-owned and never hand-edited.
 *
 * `ref` a *branch* name is the case `fetch` alone doesn't actually update: `fetch` only moves
 * `origin/<ref>`, never the local branch of the same name, so a workdir already checked out onto
 * that branch from an earlier build stayed frozen at whatever commit it first cloned, forever --
 * `checkout ref` switches to (or stays on) the existing *local* branch, and `reset --hard ref`
 * then resets to that same stale local tip, a no-op dressed up as a real reset. Invisible the first
 * time any repo is ever built (a fresh clone's local branch already matches origin), and invisible
 * for a tag or a raw commit sha (neither ever has a moving `origin/<ref>` to fall behind) -- only
 * found rebuilding a *branch* ref a second time after new commits landed on it, which is exactly
 * what a config-driven, idempotent `init` rerun does routinely. Fixed by preferring `origin/<ref>`
 * when it exists (force the local branch to match it) and falling back to `ref` itself otherwise.
 */
/**
 * One build at a time per checkout directory.
 *
 * Every part of a repo shares one working copy (`~/.mesh/repos/<repoId>`), so building several
 * parts of the same repo concurrently means several `git reset --hard` and `npm ci` runs in the
 * same directory at the same time -- and then esbuild reading it while the next build is still
 * rewriting it. The symptom is one part of a batch failing with npm's own cleanup error ("Failed
 * to remove some directories ... path argument must be of type string") while its siblings from
 * the identical repo succeed, which reads like a flaky npm rather than a race.
 *
 * Found composing a console from a clean database: six parts requested at once, four of them from
 * mesh-core, and exactly one of those four failed. Builds are dispatched by serve.queue, which runs
 * five at a time by default, so this is the ordinary case rather than an unlucky one.
 *
 * The lock covers the *whole* build, not just the checkout, because the source tree has to hold
 * still while esbuild reads it. Different repos still build in parallel.
 *
 * In-process, which covers concurrent builds on one node -- the case that fails here. Two nodes
 * sharing a machine share `$HOME` and therefore these directories too; that needs a real file
 * lock, and is worth doing if it ever bites.
 */
const checkoutLocks = new Map<string, Promise<void>>();

export async function withCheckoutLock<T>(dir: string, run: () => Promise<T>): Promise<T> {
    const previous = checkoutLocks.get(dir) ?? Promise.resolve();
    // Chained off the previous build's settlement either way: one failure must not wedge the
    // queue behind it.
    const result = previous.then(run, run);
    checkoutLocks.set(dir, result.then(() => undefined, () => undefined));
    return result;
}

/** Where a repo's single shared working copy lives. */
function checkoutDir(repo: Repo): string {
    return path.join(repoWorkdir, repo.id);
}

async function ensureRepoCheckout(repo: Repo, ref: string): Promise<string> {
    const dir = checkoutDir(repo);

    if (!(await exists(dir))) {
        await fs.mkdir(repoWorkdir, { recursive: true });
        await git(['clone', repo.url, dir]);
    } else {
        await git(['fetch', '--all', '--tags'], dir);
    }

    const hasRemoteBranch = await git(['rev-parse', '--verify', `origin/${ref}`], dir).then(() => true, () => false);
    if (hasRemoteBranch) {
        // Force the local branch to match origin's tip, exactly like a fresh clone would have.
        await git(['checkout', '-B', ref, `origin/${ref}`], dir);
    } else {
        // A tag or a raw commit sha -- neither has a moving origin/<ref> to reconcile against, and
        // `checkout -B` would wrongly turn a tag checkout into a same-named local branch instead of
        // the detached HEAD a tag checkout is supposed to produce.
        await git(['checkout', ref], dir);
        await git(['reset', '--hard', ref], dir);
    }
    await ensureNpmInstall(dir);

    return dir;
}

async function runEsbuild(
    entryPointFiles: string[], outDir: string, external: string[], platform: 'browser' | 'node' = 'browser',
    format: 'esm' | 'cjs' = 'esm',
): Promise<void> {
    for (const entryPointFile of entryPointFiles) {
        if (!(await exists(entryPointFile))) {
            throw new Error(`Entry point not found: ${entryPointFile}`);
        }
    }

    await esbuild.build({
        entryPoints: entryPointFiles,
        bundle: true,
        outdir: outDir,
        format,
        platform,
        // A service isn't loaded by a browser at all -- it's import()ed by a node process, on
        // whatever recent Node the cluster actually runs, not a browser-compat target.
        target: platform === 'node' ? 'node20' : 'es2020',
        sourcemap: true,
        minify: true,
        logLevel: 'silent',
        external,
        // Only meaningful for format: 'cjs' -- esbuild names a CJS bundle's own output file
        // `<entry>.js` by default, same as ESM, so a CJS build and an ESM build of the same entry
        // point would collide if ever written to the same outDir. Not a concern for any real caller
        // today (each build gets its own fresh outDir), but `.cjs` is also the honest extension:
        // Node treats a bare `.js` inside an ESM package (`"type": "module"`, which this precompiled
        // output ships alongside) as ESM regardless of its actual CommonJS content, and would fail
        // to `require()` it correctly otherwise.
        outExtension: format === 'cjs' ? { '.js': '.cjs' } : undefined,
    });
}

/**
 * mesh.wants.json, sibling to the part's entry point: a plain JSON array of contract keys this
 * part's code calls, e.g. ["identity.whoami", "serve.cdn.find"]. Absent means the part declares
 * nothing -- not an error, since not every part calls the mesh at all.
 */
async function readWants(repoDir: string, part: Part): Promise<string[]> {
    const file = path.join(repoDir, part.path, 'mesh.wants.json');
    if (!(await exists(file))) {
        return [];
    }
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string')) {
        throw new Error(`${file} must be a JSON array of contract key strings.`);
    }
    return raw;
}

async function walk(dir: string, base: string = dir): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await walk(full, base));
        } else {
            files.push(path.relative(base, full).split(path.sep).join('/'));
        }
    }
    return files;
}

/**
 * Hashes the built output (path + content, sorted for determinism) and moves it into its final,
 * content-addressed home under artifactDir. A hash that already exists there is left as-is --
 * identical content from a prior build, nothing to overwrite.
 */
async function hashAndStoreOutput(outDir: string): Promise<{ hash: string; assets: ArtifactAssetInput[] }> {
    const files = (await walk(outDir)).sort();

    const hasher = crypto.createHash('sha256');
    // Read once per file, reused for both the overall content hash and each file's own SRI digest
    // below -- the alternative is reading every file twice.
    const contents = new Map<string, Buffer>();
    for (const relPath of files) {
        const content = await fs.readFile(path.join(outDir, relPath));
        contents.set(relPath, content);
        hasher.update(relPath);
        hasher.update(content);
    }
    const hash = hasher.digest('hex');

    const finalDir = path.join(artifactDir, hash);
    if (!(await exists(finalDir))) {
        await fs.mkdir(artifactDir, { recursive: true });
        await fs.cp(outDir, finalDir, { recursive: true });
    }

    const assets: ArtifactAssetInput[] = files.map((relPath) => ({
        url: relPath,
        name: path.basename(relPath),
        fileExtension: path.extname(relPath) || undefined,
        integrity: `sha384-${crypto.createHash('sha384').update(contents.get(relPath) as Buffer).digest('base64')}`,
    }));

    return { hash, assets };
}

/**
 * Builds one part at one git ref: checks out the repo, bundles the part's entry with esbuild, and
 * stores the result under its content hash. Does not touch serve.artifact -- the caller records the
 * outcome.
 *
 * `external` is every other known part's `imports` specifier (this part's own excluded by the
 * caller). A part that actually imports one of them keeps the bare specifier in its output instead
 * of inlining a second copy of code the page already loaded from that part's own artifact; a part
 * that doesn't import any of them is unaffected -- esbuild only externalizes what's actually
 * imported.
 */
export async function buildPart(part: Part, repo: Repo, ref: string, external: string[]): Promise<{ hash: string; assets: ArtifactAssetInput[]; wants: string[] }> {
    return withCheckoutLock(checkoutDir(repo), async () => {
        const repoDir = await ensureRepoCheckout(repo, ref);
        const entry = path.join(repoDir, part.path, part.entryPoint);
        const wants = await readWants(repoDir, part);

        const buildTmpDir = path.join(os.tmpdir(), `mesh-build-${crypto.randomUUID()}`);
        try {
            await runEsbuild([entry], buildTmpDir, external);
            return { ...await hashAndStoreOutput(buildTmpDir), wants };
        } finally {
            await fs.rm(buildTmpDir, { recursive: true, force: true });
        }
    });
}

/**
 * Marking `@flybyme/mesh` external only helps if it's actually resolvable from wherever the built
 * file ends up -- `artifactDir` (`~/.mesh/artifacts/<hash>/`) is not inside any node project, so a
 * bare `import 'from @flybyme/mesh'` in the built output would otherwise fail outright with
 * ERR_MODULE_NOT_FOUND the moment something tried to `import()` it. One symlink at the artifact
 * store's own root, resolved once and reused: Node's module resolution walks up looking for
 * `node_modules` from the importing file's own directory, so `artifactDir/node_modules/@flybyme/mesh`
 * satisfies every hash-named subdirectory underneath it, not just this one build.
 *
 * `import.meta.resolve` (not `createRequire`) because `@flybyme/mesh`'s own `exports` map has no
 * "require" condition -- resolving it as CommonJS fails with ERR_PACKAGE_PATH_NOT_EXPORTED even
 * though the real, ESM import works fine. Locates the package's root by finding
 * `node_modules/@flybyme/mesh` in the resolved entry path, since the entry itself can be nested
 * arbitrarily deep (`dist/index.js`, etc.) and only the root needs symlinking.
 */
export async function ensureArtifactNodeModules(pkg: string): Promise<void> {
    const segments = pkg.split('/');
    const linkPath = path.join(artifactDir, 'node_modules', ...segments);

    const entryUrl = import.meta.resolve(pkg);
    const entry = fileURLToPath(entryUrl);
    const marker = path.join('node_modules', ...segments);
    const idx = entry.lastIndexOf(marker);
    if (idx === -1) {
        throw new Error(`Could not locate the "${pkg}" package root from its resolved entry: ${entry}`);
    }
    const packageRoot = entry.slice(0, idx + marker.length);

    // Not exists() (fs.stat, follows the link): a link whose target has since moved -- this repo
    // itself relocated from ~/code/mesh-serve to ~/code/mesh/mesh-serve between sessions, and the
    // artifact store's symlink kept pointing at the old path -- reads as "doesn't exist" via
    // stat, so a plain exists()-then-symlink either recreates it correctly (the original bug) or,
    // worse, silently accepts the dangling link forever (an EEXIST-means-done fix would do this).
    // fs.readlink (no follow) is the only way to tell "already correct" apart from "stale" here.
    const current = await fs.readlink(linkPath).catch(() => undefined);
    if (current === packageRoot) return;
    if (current !== undefined) await fs.unlink(linkPath);

    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.symlink(packageRoot, linkPath, 'dir');
}

/**
 * Builds a `kind: 'service'` part: a mesh `ServiceModule`, `import()`ed by a running node
 * (`serve.part.start`) rather than composed into a site. Bundled for `node`, not `browser` --
 * there is no CDN step at all, the output never leaves this machine's artifact store.
 *
 * `@flybyme/mesh` is always external, never bundled: `ServiceBroker.registerModule` duck-types the
 * module it's given (`onInit`/`getContracts`/`execute`), so a bundled, structurally-identical copy
 * would likely still work -- but the loaded module needs to observe and be observed by the *same*
 * broker instance running it, and a bundled copy of the framework is a second, disconnected one.
 * Node builtins need no such list: esbuild's own `platform: 'node'` already leaves them external.
 */
export async function buildService(part: Part, repo: Repo, ref: string): Promise<{ hash: string; assets: ArtifactAssetInput[]; wants: string[] }> {
    return withCheckoutLock(checkoutDir(repo), async () => {
        const repoDir = await ensureRepoCheckout(repo, ref);
        const entry = path.join(repoDir, part.path, part.entryPoint);
        const wants = await readWants(repoDir, part);

        await ensureArtifactNodeModules('@flybyme/mesh');

        const buildTmpDir = path.join(os.tmpdir(), `mesh-build-${crypto.randomUUID()}`);
        try {
            await runEsbuild([entry], buildTmpDir, ['@flybyme/mesh'], 'node');
            return { ...await hashAndStoreOutput(buildTmpDir), wants };
        } finally {
            await fs.rm(buildTmpDir, { recursive: true, force: true });
        }
    });
}

/**
 * Builds a kernel: one bundle, not several files stitched together at load time. A synthesized
 * entry imports the kernel plus every driver so esbuild's own module graph joins them into a
 * single output -- the client only ever loads one file. Each driver is checked out at its repo's
 * defaultBranch; per-driver ref pinning doesn't exist yet.
 *
 * How a driver actually registers itself with the kernel is mesh-web's own contract, not this
 * builder's -- the synthesized entry only guarantees kernel and drivers land in one module graph.
 * Wiring the real registration call is pending mesh-web being brought up to spec.
 */
export async function buildKernel(
    kernelPart: Part,
    kernelRepo: Repo,
    ref: string,
    drivers: readonly { part: Part; repo: Repo }[],
): Promise<{ hash: string; assets: ArtifactAssetInput[]; wants: string[] }> {
    // Locked on the kernel's own checkout. A driver's repo is checked out inside this and is *not*
    // separately locked: taking a second lock here could deadlock against a concurrent build that
    // wants the same two repos in the opposite order, and drivers are currently unused
    // (`drivers: []` in every composition). Worth revisiting -- with a deterministic lock order --
    // the first time a real driver exists.
    return withCheckoutLock(checkoutDir(kernelRepo), async () => {
    const kernelDir = await ensureRepoCheckout(kernelRepo, ref);
    const kernelEntry = path.join(kernelDir, kernelPart.path, kernelPart.entryPoint);
    const wants = new Set(await readWants(kernelDir, kernelPart));

    const driverEntries: string[] = [];
    for (const { part, repo } of drivers) {
        const driverDir = await ensureRepoCheckout(repo, repo.defaultBranch);
        driverEntries.push(path.join(driverDir, part.path, part.entryPoint));
        for (const w of await readWants(driverDir, part)) wants.add(w);
    }

    const synthDir = path.join(os.tmpdir(), `mesh-kernel-entry-${crypto.randomUUID()}`);
    await fs.mkdir(synthDir, { recursive: true });
    const synthEntry = path.join(synthDir, 'entry.ts');

    /**
     * `export *`, not a default import/export: every other part's build leaves `@flybyme/mesh-web`
     * external and the site's import map points that bare specifier straight at this artifact, so
     * this file has to look exactly like mesh-web's own `src/index.ts` to anything that imports it --
     * i.e. re-export the same named bindings (`needs`, `element`, `provider`, ...), not wrap them in
     * a default nobody asks for. A first version of this did `import kernel from ...; export default
     * kernel`, which happened to build without error (esbuild doesn't care that nothing consumes the
     * default) and only broke on a real page: `import { needs } from '@flybyme/mesh-web'` in every
     * mesh-core part failed at runtime with "does not provide an export named 'needs'". Found live,
     * building console.localhost for real -- this synthesized entry had never actually been run
     * against a real kernel part, then a real consuming part, before this session.
     */
    const lines: string[] = [`export * from ${JSON.stringify(kernelEntry)};`];
    driverEntries.forEach((entry, i) => lines.push(`import * as driver_${i} from ${JSON.stringify(entry)};`));
    lines.push(`export const drivers = [${driverEntries.map((_, i) => `driver_${i}`).join(', ')}];`);
    await fs.writeFile(synthEntry, lines.join('\n'));

    const buildTmpDir = path.join(os.tmpdir(), `mesh-build-${crypto.randomUUID()}`);
    try {
        // The kernel bundle is the one thing nothing is external to -- it's what every other part's
        // externalized specifier resolves against on the page, so it has to carry mesh-web and every
        // baked-in driver itself, not a bare import of them.
        await runEsbuild([synthEntry], buildTmpDir, []);
        return { ...await hashAndStoreOutput(buildTmpDir), wants: [...wants] };
    } finally {
        await fs.rm(synthDir, { recursive: true, force: true });
        await fs.rm(buildTmpDir, { recursive: true, force: true });
    }
    });
}
