/**
 * One collection, as a module.
 *
 * ## Why this exists, and it is not a style preference
 *
 * mesh dispatches a CRUD hook by looking up **the module whose `domain` equals the collection's
 * domain**:
 *
 * ```ts
 * const module = broker.getModule(domain);              // DatabaseMiddleware
 * if (module) params = await module.beforeCrud(…);
 * public getModule(domain) { return this.modules.find(m => m.domain === domain); }
 * ```
 *
 * So a service called `identity` that mounts the `membership` collection **never receives a hook for
 * it**. `mountCrudHook('membership', 'find', …)` registers happily, the module is asked for nothing,
 * and the hook is dead code that looks alive.
 *
 * That is the worst available failure for a narrowing hook. A hook that throws is found in a minute;
 * one that silently does not narrow returns **every row in the collection** to whoever asked, and
 * looks exactly like a working one until there are two tenants. It was found here by a read that
 * came back empty when it should have come back with a row — the *harmless* direction of the same
 * bug, and the only reason it was noticed at all.
 *
 * ## The shape
 *
 * One module per collection, `domain` matching, hooks attached where mesh will look for them. A
 * service like `IdentityService` then owns only its verbs, which is the honest split anyway: the
 * collections are data with rules, and the service is behaviour.
 */

import {
    ServiceModule, type AnyCrudContracts, type IServiceContext,
} from '@flybyme/mesh';

/** The CRUD actions a hook can be attached to, spelled as mesh spells them on the wire. */
export type CrudAction =
    | 'find' | 'find_one' | 'count' | 'get' | 'resolve'
    | 'create' | 'create_many' | 'update' | 'replace' | 'delete';

export interface CollectionHooks {
    readonly before?: (input: unknown, ctx: IServiceContext) => Promise<unknown>;
    readonly after?: (output: unknown, ctx: IServiceContext) => Promise<unknown>;
}

export interface CollectionOptions {
    /**
     * Hooks per action.
     *
     * **Named per action rather than "all reads"**, because the set of actions that need narrowing
     * is a decision per collection and a helpful default here would be one nobody wrote down.
     */
    readonly hooks?: Partial<Record<CrudAction, CollectionHooks>>;
}

export class CollectionService extends ServiceModule {
    public readonly domain: string;

    constructor(crud: AnyCrudContracts, options: CollectionOptions = {}) {
        super();

        this.domain = crud.domain;
        this.mountCrud(crud);

        for (const [action, hooks] of Object.entries(options.hooks ?? {})) {
            if (hooks === undefined) continue;
            this.mountCrudHook(this.domain, action, {
                ...(hooks.before === undefined ? {} : { before: hooks.before }),
                ...(hooks.after === undefined ? {} : { after: hooks.after }),
            });
        }
    }
}

/**
 * A hook that confines a read to rows whose `field` is the calling account.
 *
 * **Applied last and overwriting**, rather than filling in a field the caller left empty. A query
 * that already names the field is a caller asking about somebody else, and the answer to that is
 * their own rows — not a merge that honours whichever key was written second.
 *
 * A caller with no identity gets `''`, which matches nothing. **Nothing, not everything**: the
 * failure mode of a narrowing hook is that it quietly does not narrow, so the no-caller case has to
 * be the empty one by construction rather than by a check somebody remembers to write.
 */
export function ownRowsOnly(field: string): (input: unknown, ctx: IServiceContext) => Promise<unknown> {
    return async (input, ctx) => {
        const params = (typeof input === 'object' && input !== null ? input : {}) as {
            query?: Record<string, unknown>;
        };
        const existing = typeof params.query === 'object' && params.query !== null ? params.query : {};

        return { ...params, query: { ...existing, [field]: ctx.meta?.user?.id ?? '' } };
    };
}
