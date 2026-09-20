import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { MeshError } from '@flybyme/mesh';
import type { IServiceContext, IServiceModule } from '@flybyme/mesh';

const require = createRequire(import.meta.url);

/**
 * The generic half of "dynamically load a built module and register it" -- everything
 * `startService.ts` did *after* resolving which file to load, extracted so a second caller (the
 * precompiled core-parts loader `start`/`bootstrap` use for mesh-serve's own identity/cdn/hold/
 * queue/api) can share it instead of re-implementing it.
 *
 * `.cjs` uses `require()`, not `import()` -- deliberately, even though Node's ESM loader can import
 * a CommonJS file transparently. The whole reason a part would be built as CJS in the first place
 * (`runEsbuild`'s `format` parameter, `build.ts`) is real eviction: `import()` of any module, CJS or
 * ESM, is cached in the ESM module registry, which has no public way to clear an entry -- only
 * `require.cache` deletion genuinely frees one (verified directly, see
 * docs/CONTRACT_DRIVEN_PLACEMENT.md's eviction section). Loading a `.cjs` file via `import()` here
 * would work today and quietly foreclose that later.
 */
/**
 * What a loaded bundle may export, in either of the two shapes a part can take:
 *
 * - `register` -- a standalone part: a plain function handed the broker, which registers whatever it
 *   owns (`registerCrud`/`registerContract`/`registerCrudHook`/`registerEventHandler`) and returns
 *   the domain it registered under. No class, no `ServiceModule`. This is the shape parts migrate
 *   *to*.
 * - `default` -- the legacy shape: a constructor producing an `IServiceModule`, constructed and
 *   handed to `broker.registerModule`. This is the shape parts migrate *from*.
 *
 * Supporting both is what makes the migration incremental rather than a flag day: a part can move
 * to `register` on its own schedule, and nothing that loads parts has to know which era a given one
 * belongs to. `register` is checked first so a module that somehow exports both is unambiguous.
 */
interface LoadedPart {
    register?: (broker: IServiceContext['broker']) => string | Promise<string>;
    default?: new () => IServiceModule;
}

export async function loadAndRegisterModule(ctx: IServiceContext, absolutePath: string): Promise<{ domain: string; nodeID: string }> {
    const isCjs = absolutePath.endsWith('.cjs');
    // pathToFileURL, not the bare path: Node's dynamic import() accepts an absolute path on POSIX
    // by convention rather than by spec, and a Windows-hosted supervisor would refuse it outright.
    const imported = isCjs
        ? (require(absolutePath) as LoadedPart)
        : (await import(pathToFileURL(absolutePath).href) as LoadedPart);

    if (typeof imported.register === 'function') {
        const domain = await imported.register(ctx.broker);
        return { domain, nodeID: ctx.nodeID };
    }

    if (imported.default === undefined) {
        throw new MeshError({
            message: `"${absolutePath}" exports neither \`register\` (a standalone part) nor a default export (a ServiceModule constructor).`,
            code: 'BAD_REQUEST',
            status: 400,
        });
    }

    const instance = new imported.default();
    await ctx.broker.registerModule(instance);
    return { domain: instance.domain, nodeID: ctx.nodeID };
}
