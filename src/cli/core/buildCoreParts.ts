#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

import { discoverPartContracts } from './discoverPartContracts.js';

/**
 * Precompiles mesh-serve's own non-kernel services (identity, cdn, hold, queue, api) into
 * standalone CommonJS bundles, shipped inside this package at `dist/parts/*.cjs` -- what `start`/
 * `bootstrap` load directly (`catalog/methods/loadModule.ts`) instead of statically importing and
 * `registerModule()`-ing all six services the way `start.ts` used to.
 *
 * `serve.part`/`serve.repo`/`serve.artifact` are deliberately not involved for these five: giving
 * mesh-serve a `serve.repo` row pointing at its own git repo, just so it could build itself through
 * the same pipeline a third party's service goes through, would be recursive and fragile at exactly
 * the moment (bootstrap, on a brand-new node) nothing else is configured yet. These five are not
 * catalog-managed parts -- they're the platform's own boot components, closer to a kernel's built-in
 * drivers than a user's deployed service. `serve.catalog` itself stays the one thing `start`
 * mounts statically; it alone owns the mechanism (`serve.part.start`) that loads everything a real
 * third party deploys.
 *
 * CommonJS, not ESM, for the same reason `runEsbuild`'s new `format` parameter (`catalog/methods/
 * build.ts`) exists at all: only a `require()`'d module can ever be evicted for real
 * (`require.cache` deletion), matching the eviction design already decided in
 * docs/CONTRACT_DRIVEN_PLACEMENT.md for on-demand contracts generally.
 */

/**
 * Marks a part whose entry point is synthesized rather than read from disk.
 *
 * A bundle is a single file, so at runtime there are no modules left inside it for `loadDomain` to
 * import from the paths its contracts declare. It needs the mapping precomputed -- but that mapping
 * is derived entirely from those same declarations, so writing it into `src/` would put a
 * generated artifact in the repo for a purely build-time need. It is built here instead, handed
 * straight to esbuild, and exists only inside the `.cjs` output.
 *
 * Unbundled, none of this applies: the files really are at the declared paths, and
 * `catalog/methods/resolveHandler.ts` just imports them.
 */
const MANIFEST_PREFIX = 'mesh-part:';

/**
 * Synthesizes each migrated part's entry module: the side-effect imports that register its
 * contracts, the domains it implements, and tool key -> handler import.
 */
function manifestPlugin(): esbuild.Plugin {
    return {
        name: 'mesh-part-manifest',
        setup(build) {
            build.onResolve({ filter: /^mesh-part:/ }, (args) => ({
                path: args.path.slice(MANIFEST_PREFIX.length),
                namespace: 'mesh-part',
            }));

            build.onLoad({ filter: /.*/, namespace: 'mesh-part' }, (args) => {
                const partDir = path.resolve(args.path);
                const { domains, contractModules, handlers } = discoverPartContracts(partDir);

                const importPath = (target: string): string =>
                    './' + path.relative(partDir, target).replace(/\\/g, '/');

                let contents = '';
                for (const module of contractModules) {
                    contents += `import '${importPath(module)}';\n`;
                }
                contents += `export const domains = [${domains.map((d) => `'${d}'`).join(', ')}];\n`;
                contents += 'export const handlers = {\n';
                for (const h of handlers) {
                    contents += `    '${h.toolKey}': () => import('${importPath(h.modulePath)}').then((m) => m.${h.exportName}),\n`;
                }
                contents += '};\n';

                return { contents, resolveDir: partDir, loader: 'ts' };
            });
        },
    };
}

/**
 * A migrated part has no entry file. It is named by the directory its contracts live in, and its
 * entry is synthesized at build time by `manifestPlugin` below. The two still naming a
 * `*.service.ts` are the ones still on `ServiceModule`.
 */
const CORE_PARTS: Record<string, string> = {
    identity: MANIFEST_PREFIX + 'src/identity',
    cdn: MANIFEST_PREFIX + 'src/cdn',
    hold: MANIFEST_PREFIX + 'src/hold',
    queue: MANIFEST_PREFIX + 'src/queue',
    api: 'src/api/api.service.ts',
};

async function main(): Promise<void> {
    await esbuild.build({
        entryPoints: CORE_PARTS,
        plugins: [manifestPlugin()],
        bundle: true,
        outdir: 'dist/parts',
        entryNames: '[name]',
        format: 'cjs',
        platform: 'node',
        target: 'node20',
        sourcemap: true,
        minify: true,
        logLevel: 'info',
        // Resolved from this package's own node_modules at runtime -- no artifact-store symlink
        // trick needed (Database.methods.build.ts's ensureArtifactNodeModules), since these bundles
        // live inside mesh-serve's own installed package, where @flybyme/mesh is already a real,
        // ordinary dependency.
        external: ['@flybyme/mesh'],
        outExtension: { '.js': '.cjs' },
    });
}

main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
});
