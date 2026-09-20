import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { MeshError } from '@flybyme/mesh';
import type { ContractHandlerMap, IServiceContext, IServiceModule } from '@flybyme/mesh';

import { resolveHandler } from './resolveHandler.js';

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
/**
 * What `register` may return. A stateless part just names its domain; one that owns something with
 * a lifetime -- an HTTP listener, a timer -- returns a `stop` alongside it, which is the standalone
 * equivalent of `ServiceModule.onStop`. `register` itself is the equivalent of `onStart`: it runs
 * at load, with the broker already live, which is precisely when a listener should bind or a timer
 * should start.
 */
export type PartRegistration = string | { domain: string; stop?: () => void | Promise<void> };

interface LoadedPart {
    /** The generated manifest shape -- see `handlers.generated.ts`. Preferred over everything else. */
    domains?: readonly string[];
    handlers?: ContractHandlerMap;
    register?: (broker: IServiceContext['broker']) => PartRegistration | Promise<PartRegistration>;
    default?: new () => IServiceModule;
}

/**
 * Teardown for standalone parts, by domain. `ServiceModule` parts don't need this --
 * `broker.unregisterModule` already calls their own `onStop` -- so only the standalone ones are
 * tracked here, and `stopLoadedPart` is a no-op for anything that didn't register one.
 */
const partTeardown = new Map<string, () => void | Promise<void>>();

/** Runs a standalone part's own `stop`, if it registered one, and forgets it. */
export async function stopLoadedPart(domain: string): Promise<void> {
    const stop = partTeardown.get(domain);
    if (!stop) return;
    partTeardown.delete(domain);
    await stop();
}

/**
 * The minimal set of domains that covers all of them, given that loading a domain also loads its
 * sub-domains. `['identity', 'identity.user', 'identity.role']` -> `['identity']`.
 */
export function rootDomains(domains: readonly string[]): string[] {
    return domains.filter((domain) => !domains.some((other) => other !== domain && domain.startsWith(`${other}.`)));
}

export async function loadAndRegisterModule(ctx: IServiceContext, absolutePath: string): Promise<{ domain: string; nodeID: string }> {
    const isCjs = absolutePath.endsWith('.cjs');
    // pathToFileURL, not the bare path: Node's dynamic import() accepts an absolute path on POSIX
    // by convention rather than by spec, and a Windows-hosted supervisor would refuse it outright.
    const imported = isCjs
        ? (require(absolutePath) as LoadedPart)
        : (await import(pathToFileURL(absolutePath).href) as LoadedPart);

    // The generated-manifest shape: the part states its domains and where each handler lives, and
    // `loadDomain` does the rest. Nothing here enumerates contracts, and there is no per-part code
    // to write or keep in step. Checked first because it is what parts migrate *to*.
    if (Array.isArray(imported.domains) && imported.handlers !== undefined) {
        const handlers = imported.handlers;
        const [primary] = imported.domains;
        if (primary === undefined) {
            throw new MeshError({
                message: `"${absolutePath}" exports an empty \`domains\` list -- a part has to implement at least one.`,
                code: 'BAD_REQUEST',
                status: 400,
            });
        }
        // Roots only. `loadDomain(d)` takes `d` *and its sub-domains*, so a part listing
        // `identity` alongside `identity.role` would mount identity.role twice -- which
        // registerContract correctly refuses. The list stays complete (it describes the part);
        // deciding which of those calls is redundant belongs here, where that rule lives.
        for (const domain of rootDomains(imported.domains)) {
            // `resolve` as well as the map: a bundle's map covers everything it bundled, but a part
            // loaded from real files on disk has no map at all, and the two share this one path
            // rather than diverging.
            await ctx.broker.loadDomain(domain, handlers, { resolve: resolveHandler });
        }
        return { domain: primary, nodeID: ctx.nodeID };
    }

    if (typeof imported.register === 'function') {
        const registration = await imported.register(ctx.broker);
        const domain = typeof registration === 'string' ? registration : registration.domain;
        if (typeof registration !== 'string' && registration.stop) {
            partTeardown.set(domain, registration.stop);
        }
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
