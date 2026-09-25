import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { MeshError, toolKey } from '@flybyme/mesh';
import type { ContractHandlerMap, IServiceContext } from '@flybyme/mesh';

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
 * - `domains` + `handlers` -- the manifest shape, and the one to write. The part states which
 *   domains it implements and where each handler lives, and `loadDomain` does the rest. Because
 *   the load records exactly which contracts it mounted, unloading can reverse precisely that.
 * - `register` -- a plain function handed the broker, which mounts whatever it owns
 *   (`registerCrud`/`registerContract`/`registerCrudHook`/`registerEventHandler`) and returns the
 *   domain it registered under. It tells nobody what it mounted, so it runs inside a
 *   `broker.withOwner` scope, and unloading reverses the whole scope (`unregisterOwner`).
 *
 * `domains` is checked first, so a bundle exporting both is unambiguous.
 */
/**
 * What `register` may return. A stateless part just names its domain; one that owns something with
 * a lifetime -- an HTTP listener, a timer -- returns a `stop` alongside it. `register` runs at
 * load, with the broker already live, which is precisely when a listener should bind or a timer
 * should start. A contract that declares its own `concurrency` needs neither half: `ctx.signal`
 * is the stop, and the broker owns an interval's timer.
 */
export type PartRegistration = string | { domain: string; stop?: () => void | Promise<void> };

interface LoadedPart {
    /** The manifest shape -- built as a virtual esbuild module, never written to `src/`. */
    domains?: readonly string[];
    handlers?: ContractHandlerMap;
    register?: (broker: IServiceContext['broker']) => PartRegistration | Promise<PartRegistration>;
}

/**
 * Teardown for `register`-shaped parts, by domain. `stopLoadedPart` is a no-op for anything that
 * didn't return one -- which is every manifest-shaped part, since a contract's own `ctx.signal`
 * is its stop.
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
 * Exactly what one load put onto one node, so unloading can reverse it rather than guess.
 *
 * Keyed by node as well as path: a single process hosting two brokers is a real case (any
 * multi-node test), and a part-scoped key would have one node's unload tear down the other's --
 * the same mistake the running-services registry made with a bare partId.
 */
interface LoadedPartRecord {
    readonly domains: readonly string[];
    /** Tool keys `loadDomain` actually mounted, which is what unregisterContract needs. */
    readonly contracts: readonly string[];
    /**
     * The `broker.withOwner` scope the load ran in. Contracts are listed above, but a part also
     * registers things no list shows -- event handlers, CRUD hooks -- and `unregisterOwner(owner)`
     * is what takes those back. Before it, a part reloaded in place (a re-pin) left its old event
     * handlers subscribed beside the new module's, so every event ran both builds' code.
     */
    readonly owner: string;
}

const loadedParts = new Map<string, LoadedPartRecord>();

function partKey(nodeID: string, absolutePath: string): string {
    return `${nodeID}\u0000${absolutePath}`;
}

function ownerOf(nodeID: string, absolutePath: string): string {
    return `part:${absolutePath}@${nodeID}`;
}

/**
 * Unmounts a loaded part and drops its module, so the next load genuinely re-reads it from disk.
 *
 * Two halves, and the order matters:
 *
 * 1. **Unregister every contract it mounted.** For a `long-running` or `interval` contract this is
 *    what actually stops it -- `unregisterContract` aborts the registration-scoped `ctx.signal`,
 *    which is what a listener registered its `close()` on and what clears an interval's timer.
 *    Nothing else has to know that a part owned a port or a loop.
 * 2. **Delete the CommonJS cache entry.** This is the whole reason parts are built as CJS and
 *    loaded with `require()` rather than `import()`: an ES module, once evaluated, stays in the
 *    loader's registry for the life of the process with no supported way to drop it. Only the
 *    part's own bundle is evicted; `@flybyme/mesh` is external to it and shared, so it stays.
 *
 * **The re-loaded part lives in a new module realm.** Its module-level state starts empty -- which
 * is the point -- but it also gets fresh copies of anything the bundle defines, so a reference
 * held across an unload (a class for an `instanceof`, a captured closure) now points at the old
 * realm. That is the same hazard documented in `MESH_ERROR_BRAND`, and it is inherent to eviction
 * rather than incidental: recognizing something across an unload needs a structural check.
 */
export async function unloadAndEvictModule(ctx: IServiceContext, absolutePath: string): Promise<{ domains: string[]; contracts: number; evicted: boolean }> {
    const key = partKey(ctx.nodeID, absolutePath);
    const record = loadedParts.get(key);

    if (record === undefined) {
        throw new MeshError({
            message: `Nothing loaded from "${absolutePath}" on this node.`,
            code: 'NOT_FOUND',
            status: 404,
        });
    }

    for (const domain of record.domains) {
        await stopLoadedPart(domain);
    }

    for (const toolKey of record.contracts) {
        ctx.broker.unregisterContract(toolKey);
    }
    // Everything else the load registered -- event handlers, CRUD hooks -- and any contract the
    // list above missed. Only what is still this load's own is removed.
    ctx.broker.unregisterOwner(record.owner);

    // `require.resolve` rather than the raw path: the cache is keyed by the resolved filename, and
    // a caller could hand us a path that differs by a symlink or a trailing segment.
    let evicted = false;
    try {
        const resolved = require.resolve(absolutePath);
        if (require.cache[resolved] !== undefined) {
            delete require.cache[resolved];
            evicted = true;
        }
    } catch {
        // Not a CommonJS module -- an ESM part was loaded with import() and cannot be dropped.
        // Its contracts are still unmounted, which is the part that affects behavior.
        evicted = false;
    }

    loadedParts.delete(key);
    return { domains: [...record.domains], contracts: record.contracts.length, evicted };
}

/** Whether this node currently has anything loaded from `absolutePath`. */
export function isPartLoaded(nodeID: string, absolutePath: string): boolean {
    return loadedParts.has(partKey(nodeID, absolutePath));
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
        const owner = ownerOf(ctx.nodeID, absolutePath);
        const mounted: string[] = [];
        await ctx.broker.withOwner(owner, async () => {
            for (const domain of rootDomains(imported.domains ?? [])) {
                // `resolve` as well as the map: a bundle's map covers everything it bundled, but a
                // part loaded from real files on disk has no map at all, and the two share this one
                // path rather than diverging.
                const { contracts } = await ctx.broker.loadDomain(domain, handlers, { resolve: resolveHandler });
                mounted.push(...contracts);
            }
        });
        // Recorded so unloadAndEvictModule can reverse exactly this, rather than re-deriving it
        // from a manifest that may since have been evicted.
        loadedParts.set(partKey(ctx.nodeID, absolutePath), { domains: [...imported.domains], contracts: mounted, owner });
        return { domain: primary, nodeID: ctx.nodeID };
    }

    if (typeof imported.register === 'function') {
        // `register(broker)` mounts whatever it likes with no obligation to say what -- but
        // every contract it mounts is already sitting in `broker.listContracts()` the instant
        // `registerContract`/`registerCrud` runs, because that is the whole point of the list.
        // Snapshotting it before and after is what `loadDomain` gets for free by filtering the
        // *same* information down to one domain before mounting anything; `register` mounts
        // first and names no domain up front, so the only difference is doing the filtering
        // after the fact instead of before. No change needed in any `register.ts` -- this reads
        // real broker state, not something the part has to opt into reporting.
        const before = new Set(ctx.broker.listContracts().map((contract) => toolKey(contract)));

        // Inside an owner scope, so whatever `register` subscribes -- which the contract snapshot
        // below cannot see -- is taken back on unload too.
        const owner = ownerOf(ctx.nodeID, absolutePath);
        const register = imported.register;
        const registration = await ctx.broker.withOwner(owner, () => register(ctx.broker));
        const domain = typeof registration === 'string' ? registration : registration.domain;
        if (typeof registration !== 'string' && registration.stop) {
            partTeardown.set(domain, registration.stop);
        }

        const mounted = ctx.broker.listContracts()
            .map((contract) => toolKey(contract))
            .filter((key) => !before.has(key));

        loadedParts.set(partKey(ctx.nodeID, absolutePath), { domains: [domain], contracts: mounted, owner });
        return { domain, nodeID: ctx.nodeID };
    }

    throw new MeshError({
        message: `"${absolutePath}" exports neither \`domains\`+\`handlers\` (the manifest shape) nor \`register\` -- a part has to be one of the two.`,
        code: 'BAD_REQUEST',
        status: 400,
    });
}
