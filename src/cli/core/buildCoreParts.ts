#!/usr/bin/env node
import * as esbuild from 'esbuild';

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

const CORE_PARTS: Record<string, string> = {
    identity: 'src/identity/identity.service.ts',
    cdn: 'src/cdn/cdn.service.ts',
    hold: 'src/hold/hold.service.ts',
    queue: 'src/queue/queue.service.ts',
    api: 'src/api/api.service.ts',
};

async function main(): Promise<void> {
    await esbuild.build({
        entryPoints: CORE_PARTS,
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
