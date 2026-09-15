import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
 * Clones a repo on first use, otherwise fetches; either way leaves the workdir checked out at ref.
 * The workdir is reused across builds of the same repo -- it is builder-owned and never hand-edited.
 */
async function ensureRepoCheckout(repo: Repo, ref: string): Promise<string> {
    const dir = path.join(repoWorkdir, repo.id);

    if (!(await exists(dir))) {
        await fs.mkdir(repoWorkdir, { recursive: true });
        await git(['clone', repo.url, dir]);
    } else {
        await git(['fetch', '--all', '--tags'], dir);
    }

    await git(['checkout', ref], dir);
    await git(['reset', '--hard', ref], dir);

    return dir;
}

async function runEsbuild(entryPointFiles: string[], outDir: string, external: string[]): Promise<void> {
    for (const entryPointFile of entryPointFiles) {
        if (!(await exists(entryPointFile))) {
            throw new Error(`Entry point not found: ${entryPointFile}`);
        }
    }

    await esbuild.build({
        entryPoints: entryPointFiles,
        bundle: true,
        outdir: outDir,
        format: 'esm',
        platform: 'browser',
        target: 'es2020',
        sourcemap: true,
        minify: true,
        logLevel: 'silent',
        external,
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
}
