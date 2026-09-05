/**
 * The `api` ServiceModule — **the only security boundary in the system.**
 *
 * Everything else in this repository is plumbing. A cdn serves public bytes; a builder runs on a
 * commit somebody already had; the catalog answers what exists. This is the file where an anonymous
 * request from the internet becomes a call made by somebody, in an organization, against a contract
 * a site chose to expose.
 *
 * ## It is the cdn's twin
 *
 * `Host → site`, bind a port, the same records with the same invalidation. One serves files and the
 * other serves calls, and that is the only difference that earns a separate module.
 *
 * ## It owns no collections
 *
 * `mountCrud` is called **zero times**, which makes it unlike every other service here. What a site
 * exposes is `site.mesh`, owned by the cdn; tickets are identity's; the exposure hash is derived from
 * both. That is what *the api is a projection* means — and if it ever grows a collection, the first
 * question is which service should have owned it.
 *
 * ## The request path
 *
 * ```
 * Host → site → route table → gate → broker.call(key, input, { meta }) → response
 * ```
 *
 * Every step is a lookup except the gate.
 */

import { globalContractRegistry, MeshError, ServiceModule, type IServiceBroker } from '@flybyme/mesh';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { canonical, digestOf } from '../builder/methods/content.js';
import type { Site } from '../cdn/contracts/site.contract.js';
import { hostOf } from '../cdn/methods/hostname.js';
import { describeContract } from './contracts/api.contract.js';
import { api_describe } from './tools/describe.js';
import { toHttpError } from './methods/errors.js';
import { executeGate, SCOPE_HEADER, type Caller } from './methods/gate.js';
import { coerceToSchema, formatZodError } from './methods/input.js';
import { matchRoute, routeTable, type ContractLookup, type RouteTable } from './methods/routes.js';
import { createTicketCache, type TicketCache } from './methods/tickets.js';
import type { AuthorizeHook } from './methods/gate.js';

export const EXPOSURE_HEADER = 'x-exposure';

export interface ApiServiceOptions {
    /** `0` picks one, which is what a test wants. */
    readonly port?: number;
    readonly host?: string;
    /** See the cdn: trusting `x-forwarded-host` is a deployment decision, never a guess. */
    readonly trustForwardedHost?: boolean;
    readonly cacheTtlMs?: number;
    /**
     * The site's own answer to *in which organization, and may they do this there*.
     *
     * Optional, and its absence is a real configuration: a site exposing only `auth` gates needs no
     * hook, and one exposing a `permission` gate without a hook has every such call **refused**
     * rather than served ungated. A misconfigured deployment fails closed.
     */
    readonly authorize?: AuthorizeHook;
    /** Which origins a browser may call from. Absent means none, which is the safe default. */
    readonly allowOrigins?: readonly string[];
}

export const DEFAULT_TTL_MS = 30_000;

export class ApiService extends ServiceModule {
    public readonly domain = 'api';

    public listener: Server | undefined;
    public port: number | undefined;

    private broker: IServiceBroker | undefined;
    private tickets: TicketCache | undefined;
    private readonly ttl: number;

    /**
     * Two caches, each keyed by what invalidates it.
     *
     * A site's record is mutable and this node may miss the event that says so, because the mesh
     * delivers at-most-once — hence a TTL. A route table is derived from one site record, so it is
     * keyed on that record's `updatedAt` and a change produces a different key rather than a stale
     * value.
     */
    private readonly sites = new Map<string, { site: Site | undefined; expires: number }>();
    private readonly tables = new Map<string, RouteTable>();

    constructor(private readonly options: ApiServiceOptions = {}) {
        super();
        this.ttl = options.cacheTtlMs ?? DEFAULT_TTL_MS;

        // No mountCrud. See the header: this service owns nothing.
        this.mountTool(describeContract, api_describe);

        this.mountEventHandler('cdn.site_deployed', (payload) => {
            this.sites.delete(payload.host);
        });
    }

    async onStart(broker: IServiceBroker): Promise<void> {
        this.broker = broker;

        /**
         * The one adapter between identity's answer and the cache's question.
         *
         * `identity.ticket_validate` answers **flat** — `{ valid, userId, roles, expiresAt, epoch }` —
         * and the cache wants a caller **nested** under `caller`. Handing the reply straight through
         * type-checks, because everything the cache reads is optional, and then every ticket resolves
         * to no caller at all: a valid ticket becomes an anonymous request, and every gate above
         * `public` answers 401.
         *
         * Found by the first real request through this file. Nothing either side could have caught
         * alone — identity's tests assert its own shape and the cache's tests supply their own
         * validator — which is the argument for an integration test in one bug.
         */
        this.tickets = createTicketCache({
            validate: async (ticket) => {
                const answer = await this.call<{
                    valid: boolean; userId?: string; roles?: string[]; expiresAt?: number;
                }>('identity.ticket_validate', { ticket });

                if (!answer.valid || answer.userId === undefined) return { valid: false };

                return {
                    valid: true,
                    caller: { userId: answer.userId, roles: answer.roles ?? [] },
                    ...(answer.expiresAt === undefined ? {} : { expiresAt: answer.expiresAt }),
                };
            },
        });

        this.listener = await this.listen(this.options.port ?? 0, this.options.host ?? '0.0.0.0');
        const address = this.listener.address();
        this.port = typeof address === 'object' && address !== null ? address.port : this.options.port;

        broker.logger.info(`[api] serving on ${String(this.port)}`);
    }

    async onStop(): Promise<void> {
        const open = this.listener;
        this.listener = undefined;
        if (open === undefined) return;
        await new Promise<void>((done) => { open.close(() => { done(); }); });
    }

    private listen(port: number, host: string): Promise<Server> {
        const server = createServer((req, res) => { void this.handle(req, res); });
        return new Promise((resolve, reject) => {
            server.listen(port, host, () => { resolve(server); });
            server.once('error', reject);
        });
    }

    // ------------------------------------------------------------------ the request

    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const host = hostOf(req.headers, this.options.trustForwardedHost ?? false);
        const [path] = (req.url ?? '/').split('?');
        const origin = header(req, 'origin');

        try {
            if (req.method === 'OPTIONS') {
                return send(res, 204, this.cors(origin), '');
            }

            const site = await this.siteFor(host);
            if (site === undefined) {
                return send(res, 404, this.cors(origin), {
                    error: 'NO_SITE', message: 'No site is configured for this hostname.',
                });
            }

            const table = await this.tableFor(site);
            const found = matchRoute(table, req.method ?? 'GET', stripBase(path ?? '/'));

            const headers = { ...this.cors(origin), [EXPOSURE_HEADER]: table.exposure };

            if (found === undefined) {
                return send(res, 404, headers, { error: 'NO_ROUTE', message: 'Not found' });
            }

            // The ticket, from the one place it is ever read. An invalid one makes the caller
            // *anonymous*, not refused — the gate decides whether anonymous is good enough, and a
            // public contract is reachable without one.
            const caller: Caller | undefined = await this.tickets?.resolve(bearer(req));

            const input = coerceToSchema(found.route.contract.inputSchema, {
                ...parseQuery(req.url ?? ''),
                ...await readBody(req),
                // Path params last: a route with `:id` in the path and `id` in the body is a caller
                // trying to act on one record through another's URL, and the URL is the one the
                // router and the gate agreed on.
                ...found.params,
            });

            const outcome = await executeGate({
                gate: found.route.gate,
                contract: found.route.contract,
                caller,
                requestedScope: header(req, SCOPE_HEADER),
                input,
                ...(this.options.authorize === undefined ? {} : { authorize: this.options.authorize }),
            });

            if (!outcome.ok) {
                return send(res, outcome.status, headers, {
                    error: outcome.code, message: outcome.message,
                });
            }

            const parsed = found.route.contract.inputSchema.safeParse(input);
            if (!parsed.success) {
                return send(res, 400, headers, {
                    error: 'INVALID_INPUT', message: formatZodError(parsed.error),
                });
            }

            /**
             * Who is asking, carried across the broker.
             *
             * The scope comes from the **gate**, never from the request. A caller names an
             * organization in a header; the gate resolves it against their memberships and returns
             * what they may actually act in — so what reaches the handler is a resolved scope rather
             * than a requested one, and the two are different in exactly the case that matters.
             */
            const result = await this.call(found.route.key, parsed.data, {
                meta: {
                    ...(caller === undefined ? {} : {
                        user: { id: caller.userId, tenant_id: outcome.scope ?? '', roles: [...caller.roles] },
                    }),
                    ...(outcome.scope === undefined ? {} : { tenant_id: outcome.scope }),
                },
            });

            send(res, successStatus(found.route.method, found.route.contract.action), headers, result);
        } catch (error) {
            const { status, body } = toHttpError(error);
            if (status >= 500) this.broker?.logger.error(`[api] ${host}${path ?? ''}`, error);
            send(res, status, this.cors(origin), body);
        }
    }

    /**
     * Which origins a browser may call from.
     *
     * Absent means **none**, and that is the safe default rather than an oversight: a wildcard on an
     * API that accepts a bearer ticket is the thing that makes every site on the internet a client of
     * this one. A site declares its origins; a page on a port nobody declared is refused.
     */
    private cors(origin: string | undefined): Record<string, string> {
        const allowed = this.options.allowOrigins ?? [];
        if (origin === undefined || !allowed.includes(origin)) return {};

        return {
            'access-control-allow-origin': origin,
            'access-control-allow-headers': `authorization, content-type, ${SCOPE_HEADER}`,
            'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
            'access-control-expose-headers': EXPOSURE_HEADER,
            // Not `*`: the response varies by origin, and a cache that missed that would hand one
            // site's allowance to another.
            vary: 'Origin',
        };
    }

    // ------------------------------------------------------------------ lookups

    private async siteFor(host: string): Promise<Site | undefined> {
        const held = this.sites.get(host);
        if (held !== undefined && held.expires > Date.now()) return held.site;

        // **Through `cdn.resolve_site`, not `site.find_one`.** The site collection is the cdn's, and
        // it is the one that has to become scope-restricted — an unbounded `site.find` enumerates
        // every hostname on the platform. This call carries no caller, because a browser is anonymous,
        // so a scoped find would refuse it and every page request with it. Resolving a hostname for
        // serving is a different operation from listing my sites, and it has its own door.
        const found = await this.call<Site | null>('cdn.resolve_site', { host })
            .catch(() => null);
        const site = found ?? undefined;

        // A miss is cached too: a node asked repeatedly for a hostname nobody configured is
        // otherwise a database lookup per request.
        this.sites.set(host, { site, expires: Date.now() + this.ttl });
        return site;
    }

    /**
     * The route table for a site, derived and cached on the record it came from.
     *
     * Keyed on `updatedAt`, so editing a site's exposure produces a different key rather than a stale
     * table — the invalidation is correct by construction rather than by remembering to clear.
     */
    private async tableFor(site: Site): Promise<RouteTable> {
        const key = `${site.id}:${String(site.updatedAt.getTime())}`;
        const held = this.tables.get(key);
        if (held !== undefined) return held;

        const built = routeTable(site.mesh, this.lookup(), (value) => digestOf(canonical(value)));
        if (built.unknown.length > 0) {
            // Reported and served around. A site naming one contract nothing provides should serve
            // its other twenty rather than nothing.
            this.broker?.logger.warn(
                `[api] ${site.host} exposes ${built.unknown.length} contract(s) nothing provides: ` +
                built.unknown.join(', '),
            );
        }

        this.tables.set(key, built);
        return built;
    }

    /**
     * How a contract key becomes a contract.
     *
     * `globalContractRegistry` is populated at **import time** by every module that defined a
     * contract, so what this api can route is exactly what this process has loaded — and a site
     * naming something no module here provides is answered honestly rather than by guessing a shape.
     *
     * Worth knowing: the framework's own notes say this registry is read *only* by codegen. This is
     * the second reader, and it is the same use — turning a name into a shape — which is why it is
     * the right place to read from rather than a coincidence.
     */
    private lookup(): ContractLookup {
        return (key) => globalContractRegistry.get(key) as ReturnType<ContractLookup>;
    }

    private async call<T>(tool: string, params: unknown, options?: unknown): Promise<T> {
        if (this.broker === undefined) throw new MeshError('The api is not started.');
        return await (this.broker as unknown as {
            call(tool: string, params: unknown, options?: unknown): Promise<T>;
        }).call(tool, params, options);
    }
}

// ---------------------------------------------------------------------------- request pieces

/** 201 for a creation, 200 otherwise. */
const successStatus = (method: string, action: string): number =>
    method === 'POST' && action === 'create' ? 201 : 200;

/** The ticket, from the one place it is ever read. */
function bearer(req: IncomingMessage): string | undefined {
    const value = header(req, 'authorization');
    if (value === undefined) return undefined;
    return /^Bearer\s+(.+)$/i.exec(value)?.[1]?.trim();
}

function header(req: IncomingMessage, name: string): string | undefined {
    const raw = req.headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value === undefined || value.trim() === '' ? undefined : value.trim();
}

const parseQuery = (url: string): Record<string, string> =>
    Object.fromEntries(new URL(url, 'http://x').searchParams);

/**
 * The base path a site's routes hang under.
 *
 * A contract declares `/identity/whoami`; a browser calls `/api/identity/whoami`, because a site and
 * its API share one origin behind the proxy. The prefix is stripped here rather than baked into every
 * contract, so where the API mounts stays a deployment's decision.
 */
export const BASE_PATH = '/api';

const stripBase = (path: string): string =>
    path.startsWith(BASE_PATH) ? (path.slice(BASE_PATH.length) || '/') : path;

/** At most a megabyte, because a body is a contract's input and not an upload. */
const MAX_BODY = 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (req.method === 'GET' || req.method === 'HEAD') return {};

    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of req) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > MAX_BODY) throw new MeshError({ code: 'BODY_TOO_LARGE', message: 'Body too large', status: 413 });
        chunks.push(buffer);
    }

    if (chunks.length === 0) return {};

    try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
    } catch {
        throw new MeshError({ code: 'INVALID_JSON', message: 'The body is not valid JSON.', status: 400 });
    }
}

function send(
    res: ServerResponse,
    status: number,
    headers: Readonly<Record<string, string>>,
    body: unknown,
): void {
    const payload = body === '' || body === undefined ? undefined : JSON.stringify(body);

    res.writeHead(status, {
        ...(payload === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
        // A cache between here and a browser must key on the hostname it was asked for.
        vary: 'Host',
        ...headers,
    });
    res.end(payload);
}

export default ApiService;
