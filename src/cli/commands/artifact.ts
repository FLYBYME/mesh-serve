import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Command as CommanderCommand } from 'commander';
import { z } from '@flybyme/mesh';

import { BaseCommand } from '../core/BaseCommand.js';
import { ApiError, callApi } from '../core/apiClient.js';
import { isLive, readSession } from '../core/session.js';
import { artifactFolder } from '../../catalog/methods/artifacts.js';
import { buildPart, buildService, hashOutput, type BuiltOutput } from '../../catalog/methods/build.js';
import { runningVersion } from '../../catalog/methods/upgrade.js';

/**
 * A build made outside the platform, as a folder: `manifest.json` plus `files/<path>`. What
 * `artifact-build` writes and `artifact-import` sends to `serve.artifact.importBuild`.
 */
const ManifestSchema = z.object({
    format: z.literal('mesh-serve-artifact@1'),
    kind: z.enum(['service', 'application', 'extension']),
    repo: z.string(),
    ref: z.string(),
    commit: z.string(),
    hash: z.string(),
    wants: z.array(z.string()),
    files: z.array(z.string()),
    builtWith: z.string().describe('The mesh-serve release whose builder made it'),
});
type Manifest = z.infer<typeof ManifestSchema>;

const MANIFEST = 'manifest.json';
const FILES = 'files';

/**
 * Builds a part outside the platform with the builder's own code (`buildService` / `buildPart`,
 * the functions the queue runs), for the very first builds of a fresh install -- before any builder
 * exists -- or whenever a build is made elsewhere (owner, 2026-09-28). Clones the repo at the ref
 * with this machine's git credentials, as a builder would with its own.
 */
export class ArtifactBuildCommand extends BaseCommand {
    public readonly name = 'artifact-build';
    public readonly description = 'Build a part here with the builder\'s own code, into a folder artifact-import can bring in';

    public register(program: CommanderCommand): void {
        program.command(this.name).description(this.description)
            .requiredOption('--repo <url>', 'The git remote to build from, as the part\'s serve.repo names it')
            .requiredOption('--ref <ref>', 'The git ref to build at, e.g. master')
            .requiredOption('--kind <kind>', 'service, application or extension (kernels are not supported)')
            .requiredOption('--entry <path>', 'The part\'s entryPoint, e.g. src/register.ts')
            .option('--path <dir>', 'The part\'s path inside the repo', '.')
            .option('--external <specifiers...>', 'For an application/extension: other parts\' imports to leave external, as the builder would', [])
            .requiredOption('--out <dir>', 'Where to write the build (a new or empty folder)')
            .action(async (opts: { repo: string; ref: string; kind: string; entry: string; path: string; external: string[]; out: string }) => {
                await this.execute(opts);
            });
    }

    protected async execute(opts: { repo: string; ref: string; kind: string; entry: string; path: string; external: string[]; out: string }): Promise<void> {
        const kind = z.enum(['service', 'application', 'extension']).safeParse(opts.kind);
        if (!kind.success) {
            this.logger.error(`--kind must be service, application or extension, not "${opts.kind}".`);
            process.exitCode = 1;
            return;
        }
        const existing = await fs.readdir(opts.out).catch(() => []);
        if (existing.length > 0) {
            this.logger.error(`${opts.out} is not empty.`);
            process.exitCode = 1;
            return;
        }

        const part = { path: opts.path, entryPoint: opts.entry };
        // The builder keys its checkouts by the repo record's id; here the URL stands in for one.
        const repo = { id: `external-${crypto.createHash('sha256').update(opts.repo).digest('hex').slice(0, 16)}`, url: opts.repo };
        const built: BuiltOutput = kind.data === 'service'
            ? await buildService(part, repo, opts.ref)
            : await buildPart(part, repo, opts.ref, opts.external);

        const source = artifactFolder(built.hash);
        await fs.mkdir(path.join(opts.out, FILES), { recursive: true });
        await fs.cp(source, path.join(opts.out, FILES), { recursive: true });
        const manifest: Manifest = {
            format: 'mesh-serve-artifact@1',
            kind: kind.data,
            repo: opts.repo,
            ref: opts.ref,
            commit: built.commit,
            hash: built.hash,
            wants: built.wants,
            files: built.assets.map((a) => a.url),
            builtWith: runningVersion(),
        };
        await fs.writeFile(path.join(opts.out, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
        console.log(`Built ${opts.repo} at ${built.commit.slice(0, 7)}: ${built.hash} (${manifest.files.length} files) -> ${opts.out}`);
        console.log(`Bring it in: mesh-serve artifact-import ${opts.out} --partId <the part's id>`);
    }
}

/**
 * Sends a folder from `artifact-build` to `serve.artifact.importBuild` through the signed-in api. The
 * hash is checked here first, and again by the node that stores it.
 */
export class ArtifactImportCommand extends BaseCommand {
    public readonly name = 'artifact-import';
    public readonly description = 'Bring in a build made with artifact-build, as a successful build of a part';

    public register(program: CommanderCommand): void {
        program.command(this.name).description(this.description)
            .argument('<dir>', 'The folder artifact-build wrote')
            .requiredOption('--partId <id>', 'The serve.part it is a build of')
            .option('--pin', 'Pin the part to it once stored', false)
            .action(async (dir: string, opts: { partId: string; pin: boolean }) => { await this.execute(dir, opts); });
    }

    protected async execute(dir: string, opts: { partId: string; pin: boolean }): Promise<void> {
        const manifest = ManifestSchema.safeParse(JSON.parse(await fs.readFile(path.join(dir, MANIFEST), 'utf8')));
        if (!manifest.success) {
            this.logger.error(`${path.join(dir, MANIFEST)} is not an artifact-build manifest: ${manifest.error.message}`);
            process.exitCode = 1;
            return;
        }
        const m = manifest.data;
        const contents = new Map<string, Buffer>();
        for (const file of m.files) contents.set(file, await fs.readFile(path.join(dir, FILES, ...file.split('/'))));
        if (hashOutput(contents).hash !== m.hash) {
            this.logger.error(`The files in ${dir} no longer hash to ${m.hash}: changed since they were built.`);
            process.exitCode = 1;
            return;
        }

        const session = await readSession();
        if (session.apiUrl === undefined || !isLive(session)) {
            this.logger.error('No live session. Run `mesh-serve login` first.');
            process.exitCode = 1;
            return;
        }
        const call = session.descriptor?.calls.find((c) => c.key === 'serve.artifact.importBuild');
        if (call === undefined) {
            this.logger.error(`serve.artifact.importBuild is not exposed on ${session.descriptor?.host ?? session.apiUrl}.`);
            process.exitCode = 1;
            return;
        }

        try {
            const artifact = await callApi(session.apiUrl, call, {
                partId: opts.partId, ref: m.ref, commit: m.commit, hash: m.hash, wants: m.wants, pin: opts.pin,
                files: [...contents].map(([p, content]) => ({ path: p, contentBase64: content.toString('base64') })),
            }, session.token);
            console.log(JSON.stringify(artifact, null, 2));
        } catch (err) {
            if (err instanceof ApiError) {
                this.logger.error(err.message);
                process.exitCode = 1;
                return;
            }
            throw err;
        }
    }
}
