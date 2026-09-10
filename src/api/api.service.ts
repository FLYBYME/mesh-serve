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

import { globalContractRegistry, MeshError, ServiceModule, z, type IServiceBroker } from '@flybyme/mesh';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { canonical, digestOf } from '../builder/methods/content.js';
import type { Release } from '../cdn/contracts/release.contract.js';
import type { Site } from '../cdn/contracts/site.contract.js';
import { hostOf } from '../cdn/methods/hostname.js';
import { describeContract } from './contracts/api.contract.js';
import { api_describe } from './tools/describe.js';
import { toHttpError } from './methods/errors.js';
import { callerMeta, executeGate, isOperator, SCOPE_HEADER, type Caller } from './methods/gate.js';
import { resolveCaller } from './methods/caller.js';
import { coerceToSchema, formatZodError } from './methods/input.js';
import { eventTable, type EventTable } from './methods/events.js';
import { matchRoute, routeTable, type ContractLookup, type RouteTable } from './methods/routes.js';
import { openStream, type Stream } from './methods/stream.js';
import type { Subscriber } from './methods/delivery.js';
import { createTicketCache, type TicketCache } from './methods/tickets.js';
import type { AuthorizeHook } from './methods/gate.js';
import { describeExposure, type ExposureDescriptor } from './schema/descriptor.js';
import type { ExposeEntry } from './schema/expose.js';
import type { TelemSink } from '../telem/sinks/sink.js';
import { getDefaultTelemSink } from '../telem/sinks/default.js';
import { ALWAYS_GRANTED } from '../cdn/methods/grants.js';

export const EXPOSURE_HEADER = 'x-exposure';
export const SHAPE_HEADER = 'x-exposure-shape';

/**
 * How long the api waits for a contract it dispatched. See the call site for why it is not ten
 * seconds — a request a person is waiting on is not a question between two services.
 */
export const API_CALL_TIMEOUT_MS = 15 * 60 * 1000;

/** Where a browser subscribes. One path per site, not one per event: a stream carries them all. */
export const EVENTS_PATH = '/events';

/** Where a browser discovers the site's exposure descriptor. */
export const DESCRIBE_PATH = '/_describe';

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
    /** Telemetry sink for recording requests. Falls back to default process sink. */
    readonly telem?: TelemSink;
}

export const DEFAULT_TTL_MS = 30_000;

declare global {
    interface EventRegistry {
        '*': unknown;
    }
}

export class ApiService extends ServiceModule {
    public readonly domain = 'api';

    public listener: Server | undefined;
    public port: number | undefined;

    private broker: IServiceBroker | undefined;
    private tickets: TicketCache | undefined;
    private unsubscribeEvents: (() => void) | undefined;
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
    private readonly releases = new Map<string, Release>();
    private readonly tables = new Map<string, RouteTable>();
    private readonly descriptors = new Map<string, ExposureDescriptor>();
    private readonly eventTables = new Map<string, EventTable>();

    /**
     * Every open subscription on this node.
     *
     * Held so an event arriving over the mesh can be offered to each, and so `onStop` can close them
     * — a process that exits without ending its streams leaves browsers reconnecting to a node that
     * is gone.
     */
    private readonly streams = new Set<Stream>();

    constructor(private readonly options: ApiServiceOptions = {}) {
        super();
        this.ttl = options.cacheTtlMs ?? DEFAULT_TTL_MS;

        // No mountCrud. See the header: this service owns nothing.
        this.mountTool(describeContract, api_describe);

        this.mountEventHandler('cdn.site_deployed', (payload) => {
            this.sites.delete(payload.host);
        });

        this.mountEventHandler('site.updated', (payload) => {
            const host = payload.item?.host;
            if (host !== undefined) this.sites.delete(host);
        });
    }

    async onStart(broker: IServiceBroker): Promise<void> {
        this.broker = broker;

        this.unsubscribeEvents = broker.on('*', (payload, packet) => {
            const topic = packet?.topic;
            if (topic !== undefined) {
                this.deliver(topic, payload);
            }
        });

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
                    provisional?: boolean;
                }>('identity.ticket_validate', { ticket });

                if (!answer.valid || answer.userId === undefined) return { valid: false };

                return {
                    valid: true,
                    caller: {
                        userId: answer.userId,
                        roles: answer.roles ?? [],
                        // Carried through, or the gate's provisional check can never fire — the
                        // shape of the bug this adapter already had once, where a flat answer was
                        // handed through and every ticket resolved to no caller at all.
                        ...(answer.provisional === true ? { provisional: true } : {}),
                    },
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
        if (this.unsubscribeEvents !== undefined) {
            this.unsubscribeEvents();
            this.unsubscribeEvents = undefined;
        }

        // Ended explicitly rather than dropped: a process that exits without closing its streams
        // leaves browsers reconnecting to a node that is gone, and the reconnect is indistinguishable
        // from a network blip.
        for (const stream of this.streams) stream.close('this node is shutting down');
        this.streams.clear();

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
        const start = performance.now();
        const host = hostOf(req.headers, this.options.trustForwardedHost ?? false);
        const [path] = (req.url ?? '/').split('?');
        const origin = header(req, 'origin');
        const sessionId = header(req, 'x-session-id');

        res.on('finish', () => {
            const durationMs = Math.round(performance.now() - start);
            const telem = this.options.telem ?? getDefaultTelemSink();
            telem.recordRequest({
                source: 'api',
                host,
                method: req.method ?? 'GET',
                path: path ?? '/',
                status: res.statusCode,
                durationMs,
                sessionId,
            });
        });

        /**
         * Hoisted out of the `try` so the `catch` can answer with the same allowance the success
         * path would have. See the `catch` for why an error without one is worse than the error.
         */
        let site: Site | undefined;

        try {
            /**
             * The preflight resolves the site too, and it has to.
             *
             * A browser sends `OPTIONS` *before* the real request and refuses to send that request
             * at all unless this response allows the origin. Answering the preflight without
             * knowing which site was addressed means answering it without knowing whether the
             * origin is allowed — which is how this returned a bare 204 and blocked every call.
             *
             * The `Host` header is on the preflight like any other request, so the lookup is the
             * same one and is already cached.
             */
            if (req.method === 'OPTIONS') {
                const preflight = await this.siteFor(host);
                return send(res, 204, this.cors(origin, preflight), '');
            }

            site = await this.siteFor(host);
            if (site === undefined) {
                return send(res, 404, this.cors(origin), {
                    error: 'NO_SITE', message: 'No site is configured for this hostname.',
                });
            }

            let release: Release | undefined;
            if (site.releaseHash !== undefined) {
                release = await this.releaseFor(site.releaseHash, site.tenantId);
                if (release === undefined) {
                    return send(res, 503, this.cors(origin, site), {
                        error: 'RELEASE_UNAVAILABLE', message: 'That release is not available from this node yet.',
                    });
                }
            }

            const inner = stripBase(path ?? '/');

            if (inner === EVENTS_PATH) {
                return await this.subscribe(req, res, site, origin);
            }

            if (inner === DESCRIBE_PATH) {
                return await this.describe(req, res, site, release, origin);
            }

            const table = await this.tableFor(site, release);
            const found = matchRoute(table, req.method ?? 'GET', inner);

            const headers = {
                ...this.cors(origin, site),
                [EXPOSURE_HEADER]: table.exposure,
                [SHAPE_HEADER]: table.shapeHash,
            };

            const clientExposure = header(req, EXPOSURE_HEADER);
            if (clientExposure !== undefined && clientExposure !== table.exposure) {
                return send(res, 409, headers, {
                    error: 'EXPOSURE_MISMATCH',
                    message: `Client exposure hash (${clientExposure}) does not match API exposure hash (${table.exposure}).`,
                });
            }

            const clientShape = header(req, SHAPE_HEADER);
            if (clientShape !== undefined && clientShape !== table.shapeHash) {
                return send(res, 409, headers, {
                    error: 'EXPOSURE_MISMATCH',
                    message: `Client shape hash (${clientShape}) does not match API shape hash (${table.shapeHash}).`,
                });
            }

            if (found === undefined) {
                return send(res, 404, headers, { error: 'NO_ROUTE', message: 'Not found' });
            }

            /**
             * The credential, from the one place it is ever read — **a ticket or an API token.**
             *
             * This resolved tickets only, which made the agent/person distinction true of the MCP
             * door and false of this one: the same token authenticated over MCP and was **anonymous
             * over HTTP**, so the CLI could not use the credential the platform issues to programs
             * (roadmap D10). Two entry paths over one exposure, drifting in the way that is hardest
             * to notice — everything worked, on one of the doors.
             *
             * An invalid credential makes the caller *anonymous*, not refused: the gate decides
             * whether anonymous is good enough, and a public contract is reachable without one.
             */
            const caller: Caller | undefined = await this.resolve(bearer(req));

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
                /**
                 * **The api must not give up before its own client does.**
                 *
                 * The broker's default is ten seconds, which is right for a question between two
                 * services and wrong for a request a person is holding a browser tab open for.
                 * `site.seed` clones every repository named and bundles every part in them; on this
                 * machine that is around forty seconds, and it produced the worst pair of outcomes
                 * available: the caller got `500 Internal server error` while the node logged
                 * `seeded 127.0.0.1 → sha256:89dd6ee3…` a second later. **The run failed and the
                 * work succeeded.**
                 *
                 * `site.seed` already raises the timeout on every call it makes *internally*, which
                 * is what made this so hard to see — every step inside it was allowed fifteen
                 * minutes, and the one dispatching it was allowed ten seconds.
                 *
                 * A generous ceiling rather than a per-contract table: mesh is frozen, so a contract
                 * cannot declare how long it takes, and a hand-kept list of slow ones is a list that
                 * is wrong the first time somebody adds work to a handler. The socket is the real
                 * bound — a client that stops waiting closes it — and this only has to be longer
                 * than that.
                 */
                timeout: API_CALL_TIMEOUT_MS,
                meta: {
                    ...(caller === undefined
                        /**
                         * **An anonymous request says so, rather than saying nothing.**
                         *
                         * Absence is ambiguous here and the ambiguity is a tenant leak. An internal
                         * broker call also arrives with no `user` — `organization.find` from inside
                         * the cluster is expected to answer with every row — so a handler that reads
                         * only "is there a user" cannot tell *nobody asked* from *the platform
                         * asked*, and the safe default for one is the wrong default for the other.
                         *
                         * `identity`'s `beforeCrud` was written against this flag from the start and
                         * nothing had ever set it, so an unauthenticated caller to a `public` route
                         * fell through its `if (!userId) return input` and received every
                         * organization on the platform. Proven in `test/identity/crud.test.ts`.
                         */
                        ? { unauthenticated: true }
                        : {
                            user: callerMeta(caller, outcome.scope),
                        }),
                    ...(outcome.scope === undefined ? {} : { tenant_id: outcome.scope }),
                },
            });

            send(res, successStatus(found.route.method, found.route.contract.action), headers, result);
        } catch (error) {
            const { status, body } = toHttpError(error);
            if (status >= 500) this.broker?.logger.error(`[api] ${host}${path ?? ''}`, error);
            /**
             * **`site`, not nothing — an error a browser cannot read is worse than the error.**
             *
             * This called `this.cors(origin)` with no site, so an allowance that depends on *which
             * site is asking* was never granted on any failure. The browser then refuses the
             * response before any JavaScript sees it, and reports the only thing it knows: *No
             * 'Access-Control-Allow-Origin' header is present.*
             *
             * So a 401 saying exactly what standing is missing arrived as a CORS complaint, and the
             * page rendered *Could not reach the server* over an api that had answered in
             * milliseconds. Found bringing up the operator console, where the real message —
             * *Scoped collection "site" requires a resolved "tenantId" scope* — was sitting in a
             * response nobody could open.
             *
             * A cross-origin page is the ordinary case here, not an edge one: the cdn serves on one
             * port and the api answers on another, so every deployment is cross-origin until
             * something puts them behind one name.
             */
            send(res, status, this.cors(origin, site), body);
        }
    }

    /**
     * Open a subscription.
     *
     * A `GET` that never ends. The gate runs **once, here**, exactly as it does for a call — and then
     * again on every heartbeat, because a stream outlives the request that opened it and a ticket
     * revoked five minutes in must reach a connection authorised ten minutes ago.
     */
    private async subscribe(
        req: IncomingMessage,
        res: ServerResponse,
        site: Site,
        origin: string | undefined,
    ): Promise<void> {
        // The stream is opened for a site, so it is allowed for that site's origin.
        const headers = this.cors(origin, site);

        if (req.method !== 'GET') {
            return send(res, 405, { ...headers, allow: 'GET' }, {
                error: 'METHOD_NOT_ALLOWED', message: 'A subscription is a GET.',
            });
        }

        const table = this.eventsFor(site);
        if (table.events.length === 0) {
            // Nothing to stream. A 404 rather than an idle connection, because a subscription that
            // succeeds and never delivers is the hardest failure here to tell from a working one.
            return send(res, 404, headers, {
                error: 'NO_EVENTS',
                message: table.refused.length === 0
                    ? 'This site exposes no events.'
                    : `This site exposes no streamable events. Refused: ${
                        table.refused.map((r) => `${r.name} (${r.reason})`).join('; ')}`,
            });
        }

        const ticket = bearer(req);
        const caller = await this.resolve(ticket);
        const requestedScope = header(req, SCOPE_HEADER);

        /**
         * One gate for the whole stream, at its strictest.
         *
         * A subscription carries several events with possibly different gates, and a connection is
         * one thing that either exists or does not. So it is opened only if the caller passes **every**
         * event's gate, and `offer` filters per event afterwards — which is the conservative order:
         * a caller who could receive some events gets a refusal rather than a stream that silently
         * omits the rest.
         */
        for (const event of table.events) {
            const outcome = await executeGate({
                gate: event.gate,
                contract: streamPseudoContract(event.name),
                caller,
                requestedScope,
                input: {},
                ...(this.options.authorize === undefined ? {} : { authorize: this.options.authorize }),
            });

            if (!outcome.ok) {
                return send(res, outcome.status, headers, {
                    error: outcome.code,
                    message: `${outcome.message} (subscribing to ${event.name})`,
                });
            }
        }

        const scopeOf = async (): Promise<Subscriber | undefined> => {
            /**
             * Re-resolved rather than reused, which is the point of `recheck`: a connection outlives
             * its authorisation. Costs a broker round trip for a token, and this runs on the
             * heartbeat rather than per event, so it is one call every few seconds per connection.
             */
            const current = ticket === undefined ? undefined : await this.resolve(ticket);
            if (ticket !== undefined && current === undefined) return undefined;

            const outcome = await executeGate({
                gate: table.events[0]!.gate,
                contract: streamPseudoContract(table.events[0]!.name),
                caller: current,
                requestedScope,
                input: {},
                ...(this.options.authorize === undefined ? {} : { authorize: this.options.authorize }),
            });
            if (!outcome.ok) return undefined;

            return {
                userId: current?.userId ?? '',
                scope: outcome.scope,
                // An operator sees across organizations. Platform operator is distinct from admin:
                // only a caller holding the operator role has cross-organization operator visibility.
                operator: isOperator(current),
            };
        };

        const subscriber = await scopeOf();
        if (subscriber === undefined) {
            return send(res, 401, headers, {
                error: 'UNAUTHENTICATED', message: 'That ticket is not accepted.',
            });
        }

        /**
         * A subscriber with no resolved scope receives nothing, so say so now.
         *
         * The same failure as an unscopable event, arriving from the other side: every event here is
         * narrowed by an organization, this caller is acting in none, and `decideDelivery` will
         * answer `no-subscriber-scope` for every payload forever. The stream would be open, correct
         * and silent.
         *
         * **The usual cause is a site with no `authorize` hook.** The coarse gate cannot resolve a
         * scope — only the site knows what an organization means to it — so a deployment that exposes
         * scoped events and configures no hook has built a stream that can never deliver. That is a
         * misconfiguration, and it should be visible on the first subscription rather than as an
         * absence nobody can date.
         */
        const needsScope = table.events.some((event) => event.scope !== 'global');
        if (needsScope && !subscriber.operator && subscriber.scope === undefined) {
            return send(res, 409, headers, {
                error: 'NO_SCOPE',
                message: 'Every event this site streams is scoped to an organization, and this call '
                    + 'resolved none. Name one with the ' + SCOPE_HEADER + ' header — or, if this API '
                    + 'has no authorize hook, nothing can resolve a scope and no scoped event can '
                    + 'ever be delivered.',
            });
        }

        for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);

        const stream = openStream({
            res,
            events: table.events,
            subscriber,
            recheck: scopeOf,
            onClose: () => { this.streams.delete(stream); },
        });

        this.streams.add(stream);
        this.broker?.logger.info(`[api] ${site.host}: subscription opened (${String(this.streams.size)} open)`);
    }

    /**
     * Serve the exposure descriptor for a site.
     *
     * Gated as `public`: the routes and their gates are already discoverable by probing, and
     * an anonymous client (such as a browser running schema-driven UI or models on boot) needs
     * to know which calls require authentication in advance so it can prompt for sign-in rather
     * than firing guaranteed 401s (refs surfdns#39, surfdns#40).
     *
     * Internal contracts are strictly forbidden: `descriptorFor` calls `describeExposure` with
     * `allowInternal: false`, inheriting the deny-by-default invariant.
     */
    private async describe(
        req: IncomingMessage,
        res: ServerResponse,
        site: Site,
        release: Release | undefined,
        origin: string | undefined,
    ): Promise<void> {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return send(res, 405, { ...this.cors(origin, site), allow: 'GET, HEAD' }, {
                error: 'METHOD_NOT_ALLOWED', message: 'The descriptor is a GET.',
            });
        }

        const caller: Caller | undefined = await this.resolve(bearer(req));

        const outcome = await executeGate({
            gate: { kind: 'auth', level: 'public' },
            contract: describePseudoContract(),
            caller,
            requestedScope: header(req, SCOPE_HEADER),
            input: {},
            ...(this.options.authorize === undefined ? {} : { authorize: this.options.authorize }),
        });

        if (!outcome.ok) {
            return send(res, outcome.status, this.cors(origin, site), {
                error: outcome.code, message: outcome.message,
            });
        }

        const descriptor = await this.descriptorFor(site, release);

        // It MUST carry shapeHash, NOT the exposure hash (spec/schema-driven-ui.md §3.1, net/client.ts).
        // A client asking "is my rendering stale?" is asking a site-independent question.
        const headers: Record<string, string> = {
            ...this.cors(origin, site),
            etag: descriptor.exposure,
            [SHAPE_HEADER]: descriptor.shapeHash,
            'cache-control': 'no-cache',
        };

        const clientShape = header(req, SHAPE_HEADER);
        if (clientShape !== undefined && clientShape !== descriptor.shapeHash) {
            return send(res, 409, headers, {
                error: 'EXPOSURE_MISMATCH',
                message: `Client shape hash (${clientShape}) does not match API shape hash (${descriptor.shapeHash}).`,
            });
        }

        const ifNoneMatch = header(req, 'if-none-match');
        if (ifNoneMatch !== undefined && (ifNoneMatch === descriptor.exposure || ifNoneMatch === `"${descriptor.exposure}"`)) {
            return send(res, 304, headers, '');
        }

        send(res, 200, headers, req.method === 'HEAD' ? '' : descriptor);
    }

    /**
     * An event arrived over the mesh. Offer it to every open stream.
     *
     * **Offer, not send.** Each stream decides for its own subscriber, because two connections on one
     * node belong to different people in different organizations — and the rule is that an event
     * which cannot be narrowed to a subscriber reaches nobody.
     */
    public deliver(name: string, payload: unknown): void {
        for (const stream of this.streams) stream.offer(name, payload);
    }

    /** A site's streamable events, cached on the record they came from. */
    private eventsFor(site: Site): EventTable {
        const key = `${site.id}:${String(site.updatedAt.getTime())}`;
        const held = this.eventTables.get(key);
        if (held !== undefined) return held;

        // The surface's own events ride along with the site's, for the same reason its routes do:
        // an approval that announces itself to nobody leaves the agent waiting on silence.
        const built = eventTable([...site.mesh, ...this.surfaceContracts(site.mesh)]);
        if (built.refused.length > 0) {
            this.broker?.logger.warn(
                `[api] ${site.host} exposes events that cannot be streamed: ` +
                built.refused.map((r) => `${r.name} — ${r.reason}`).join('; '),
            );
        }

        this.eventTables.set(key, built);
        return built;
    }

    /**
     * Which origins a browser may call from.
     *
     * Absent means **none**, and that is the safe default rather than an oversight: a wildcard on an
     * API that accepts a bearer ticket is the thing that makes every site on the internet a client of
     * this one. A site declares its origins; a page on a port nobody declared is refused.
     */
    /**
     * Who may call this api from a browser.
     *
     * **A site's own origin is allowed, and that is derived rather than configured.** This was an
     * allowlist on the *node* — `allowOrigins`, passed to the constructor — and `bin/node.mjs`
     * passed none, so every cross-origin call from every site was refused with a 204 carrying no
     * headers. The first console deployed against it showed *"Failed to load catalog parts"* and
     * nothing else, because the browser had blocked every request before it left.
     *
     * Configuring it per node would have worked and is the wrong shape. **The site record already
     * knows this**: the api resolves `Host → site` on every request, and the origin that should be
     * allowed to call for a site is the origin that site is served from. An allowlist beside it
     * means adding a hostname requires restarting every api node with a new flag — which defeats
     * *a deploy is one field write*, the property the whole deployment model rests on.
     *
     * Matched on **hostname**, not on the whole origin string, because a site record stores `host`
     * and nothing about scheme or port: the cdn may serve `console.localhost` on `:8081` in
     * development and `:443` behind a proxy, and the site is the same site. What must match is
     * *which site is asking*, and the hostname is that.
     *
     * `allowOrigins` stays, and is now what its name suggests — an escape hatch for an origin that
     * is **not** one of this platform's own hostnames, such as a console served from somewhere else
     * entirely during development.
     */
    private cors(origin: string | undefined, site?: Site): Record<string, string> {
        if (origin === undefined) return {};

        const allowed = this.options.allowOrigins ?? [];
        let permitted = allowed.includes(origin);

        if (!permitted && site !== undefined) {
            try {
                permitted = new URL(origin).hostname === site.host;
            } catch {
                // An unparseable Origin is not a browser we need to satisfy. Refuse rather than
                // guess: a header that is not a URL is either a bug or somebody probing.
                permitted = false;
            }
        }

        if (!permitted) return {};

        return {
            'access-control-allow-origin': origin,
            'access-control-allow-headers': `authorization, content-type, ${SCOPE_HEADER}, ${EXPOSURE_HEADER}, ${SHAPE_HEADER}`,
            'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
            'access-control-expose-headers': `${EXPOSURE_HEADER}, ${SHAPE_HEADER}`,
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
     * A release, read **as the site that points at it** — see `CdnService.releaseFor`.
     *
     * The same reasoning and the same reason it is not a bypass: `release` is scoped by tenant, a
     * request arriving here has not been authenticated yet (this is what builds the route table
     * that decides whether it needs to be), and `cdn.deploy` guarantees a deployed
     * `site.releaseHash` belongs to `site.tenantId`.
     *
     * Missing it turned every request on a deployed site into `RELEASE_UNAVAILABLE` — a 503 that
     * reads as *this node has not caught up yet* when the truth was that the node was refusing
     * itself.
     */
    private async releaseFor(hash: string, tenantId: string): Promise<Release | undefined> {
        const held = this.releases.get(hash);
        if (held !== undefined) return held;

        const found = await this.call<Release | null>(
            'release.find_one',
            { query: { hash } },
            { meta: { tenantId, organizationId: tenantId } },
        ).catch(() => null);
        if (found !== null && found !== undefined) this.releases.set(hash, found);
        return found ?? undefined;
    }

    /**
     * The route table for a site, derived and cached on the record it came from.
     *
     * Keyed on `${site.id}:${release.hash}:${site.updatedAt}` — matching the cdn's page cache key
     * and invalidation. A deploy or record edit produces a different key rather than a stale table.
     */
    private async tableFor(site: Site, release?: Release): Promise<RouteTable> {
        let activeRelease = release;
        if (activeRelease === undefined && site.releaseHash !== undefined) {
            activeRelease = await this.releaseFor(site.releaseHash, site.tenantId);
        }

        const releaseHash = activeRelease?.hash ?? site.releaseHash ?? '';
        const key = `${site.id}:${releaseHash}:${site.updatedAt?.toISOString() ?? ''}`;
        const held = this.tables.get(key);
        if (held !== undefined) return held;

        for (const dependency of site.mesh) {
            if (dependency.package) {
                try {
                    await import(dependency.package);
                } catch {
                    // ignore if package cannot be dynamically resolved
                }
            }
        }

        /**
         * The approval routes, on every site, without the site asking.
         *
         * Same rule as the MCP surface's `approval_check`: **the platform raises the question, so
         * the platform owes the way to answer it.** A site that had to grant `approval.decide`
         * would, the first time somebody forgot, collect parked calls that no person could ever act
         * on — and the agent would poll them until they expired.
         *
         * Their keys join `requires` as well, because `routeTable` routes only what the composed
         * release requires. These are required by the platform rather than by a part, which is a
         * distinction the filter has no way to express and does not need to.
         */
        const surface = this.surfaceContracts(site.mesh);
        const requires = activeRelease?.requires === undefined
            ? undefined
            : [...activeRelease.requires, ...surface.flatMap((d) => d.contracts.map((c) => c.key))];

        const built = routeTable(
            [...site.mesh, ...surface],
            this.lookup(),
            (value) => digestOf(canonical(value)),
            requires,
        );
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
     * Contracts every site serves whether it granted them or not.
     *
     * Only `approval` today, and the bar for adding to this list should stay high: a call here is
     * one a site cannot decline, which is defensible exactly when the platform is the thing that
     * created the need for it. Approvals qualify — the agent surface parks a call and hands out an
     * id, and somebody has to be able to redeem it.
     *
     * Returns nothing when no `ApprovalService` is in the process, so a node that cannot take
     * approvals serves no routes for them rather than advertising ones that 404. Skips anything the
     * site already exposes, so a site that grants them deliberately keeps its own gate.
     */
    private surfaceContracts(mesh: Site['mesh']): readonly Site['mesh'][number][] {
        const granted = new Set(mesh.flatMap((d) => d.contracts.map((c) => c.key)));
        const lookup = this.lookup();
        /**
         * Two gates, because these answer two audiences.
         *
         * `check` and `decide` are `user`: the handlers behind them do the real narrowing — `check`
         * answers only a requester or an approver, `decide` only an approver — and an agent holding
         * no role has to be able to poll its own parked call.
         *
         * `find` and `get` are `operator`, matching the event stream and `DEFAULT_APPROVER`. They
         * are the **queue**, and a queue row carries the frozen input of a call somebody was about
         * to make. At `user` every member of an organization could read what every agent in it was
         * doing.
         */
        const contracts = ([
            ['approval.check', 'user'], ['approval.decide', 'user'],
            ['approval.find', 'operator'], ['approval.get', 'operator'],
        ] as const)
            .filter(([key]) => !granted.has(key) && lookup(key) !== undefined)
            .map(([key, auth]) => ({ key, auth }));

        /**
         * **The notification, and it is not a new event.**
         *
         * `defineCrud` already fires `approval.created` and `approval.updated`, and a CRUD event's
         * delivery scope *is* its collection's `scopedBy` — `tenantId` here — so these are narrowed
         * to the organization without anything being declared twice. Inventing an
         * `approval.requested` beside them would have been a second name for a write that already
         * announces itself, and a second `scopedBy` to keep in step.
         *
         * Carried on the surface for the same reason the routes are: **an approval nobody sees is
         * worse than a refusal**, because the agent waits rather than failing. A site that had to
         * remember to expose the event would, the first time it forgot, park calls silently.
         *
         * **Gated at `operator`, which is coarser than the record.** `decideDelivery` narrows to an
         * organization, not to an approver, so an event gated at `user` would put the frozen input
         * of a parked call in front of every member of the organization — including the ones who
         * cannot decide it. `operator` matches `DEFAULT_APPROVER` and fails closed. A site naming a
         * different approver role gets no stream rather than the wrong one, which is the safe half
         * of that trade and is worth fixing when `approver` becomes the site's to choose.
         */
        const events = contracts.length === 0 ? [] : ([
            { key: 'approval.created', auth: 'operator' as const },
            { key: 'approval.updated', auth: 'operator' as const },
        ]);

        return contracts.length === 0
            ? []
            : [{ package: '@flybyme/mesh-serve', version: '0.0.0', contracts, events }];
    }

    /**
     * The exposure descriptor for a site, derived and cached on the record it came from.
     *
     * Cached on the same key as the route table: `${site.id}:${release.hash}:${site.updatedAt}`.
     * Built with `allowInternal: false` — an internal contract exposed by accident fails closed
     * rather than leaking implementation details to the internet.
     */
    private async descriptorFor(site: Site, release?: Release): Promise<ExposureDescriptor> {
        let activeRelease = release;
        if (activeRelease === undefined && site.releaseHash !== undefined) {
            activeRelease = await this.releaseFor(site.releaseHash, site.tenantId);
        }

        const releaseHash = activeRelease?.hash ?? site.releaseHash ?? '';
        const key = `${site.id}:${releaseHash}:${site.updatedAt?.toISOString() ?? ''}`;
        const held = this.descriptors.get(key);
        if (held !== undefined) return held;

        const entries: ExposeEntry[] = [];
        const seen = new Set<string>();
        const required = activeRelease?.requires !== undefined ? new Set(activeRelease.requires) : undefined;
        const lookup = this.lookup();

        for (const dependency of site.mesh) {
            if (dependency.package) {
                try {
                    await import(dependency.package);
                } catch {
                    // ignore if package cannot be dynamically resolved
                }
            }

            for (const exposed of dependency.contracts) {
                const contractKey = exposed.key;
                if (seen.has(contractKey)) continue;
                seen.add(contractKey);

                /**
                 * The release decides what a site exposes — **except for the few granted to every
                 * site whether a part declares them or not.** Those are in `requires` only by
                 * accident, so filtering by it deleted precisely them. See `ALWAYS_GRANTED`.
                 */
                if (required !== undefined
                    && !required.has(contractKey)
                    && !ALWAYS_GRANTED.includes(contractKey)) {
                    continue;
                }

                const contract = lookup(contractKey);
                if (contract === undefined) {
                    continue;
                }

                if ('auth' in exposed) {
                    entries.push({ contract, auth: exposed.auth });
                } else {
                    entries.push({ contract, permission: exposed.permission });
                }
            }
        }

        // The same three the route table adds, so `/_describe` and a generated client agree with
        // what is actually served.
        for (const dependency of this.surfaceContracts(site.mesh)) {
            for (const exposed of dependency.contracts) {
                if (seen.has(exposed.key)) continue;
                const contract = lookup(exposed.key);
                if (contract === undefined) continue;
                seen.add(exposed.key);
                /**
                 * **The gate the surface declares, not `user`.**
                 *
                 * This pushed `auth: 'user'` for every surface contract, while the route table
                 * enforces what `surfaceContracts` declares — `operator` for `approval.find` and
                 * `approval.get`, deliberately, because a queue row carries the frozen input of an
                 * agent's parked call. So `/_describe` advertised the queue to every member and the
                 * route refused them: flowboard, signed in as its own tenant owner, called
                 * `GET /api/approvals` because the descriptor said it could, and got 403. Found by
                 * the V9 sweep and confirmed on the first two-tenant cluster.
                 *
                 * A descriptor that disagrees with its routes is the one thing it must not be. It is
                 * what a generated client is built from.
                 */
                if ('auth' in exposed) {
                    entries.push({ contract, auth: exposed.auth });
                } else {
                    entries.push({ contract, permission: exposed.permission });
                }
            }
        }

        const table = this.eventsFor(site);

        try {
            const descriptor = describeExposure(entries, {
                application: site.application,
                base: BASE_PATH,
                allowInternal: false,
                events: table.events,
                // From the release, because which roles exist is part content. What the site grants
                // is still the site's, and a tool needs both: named by a role *and* exposed here.
                ...(activeRelease?.agentRoles === undefined ? {} : { agentRoles: activeRelease.agentRoles }),
            });
            this.descriptors.set(key, descriptor);
            return descriptor;
        } catch (error) {
            if (error instanceof Error) {
                const code = error.message.includes('marked internal') ? 'INTERNAL_CONTRACT' : 'INVALID_EXPOSURE';
                throw new MeshError({
                    code,
                    message: error.message,
                    status: 500,
                });
            }
            throw error;
        }
    }

    /**
     * Look up the exposure descriptor for a given hostname.
     * Used by McpService and external callers to project the same exposure.
     */
    public async descriptorForHost(host: string): Promise<ExposureDescriptor | undefined> {
        const site = await this.siteFor(host);
        if (site === undefined) return undefined;
        return await this.descriptorFor(site);
    }

    /**
     * Shared ticket cache for MCP and API surfaces in the same process.
     */
    public get ticketCache(): TicketCache | undefined {
        return this.tickets;
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
        return (key) => globalContractRegistry.get(key);
    }

    /**
     * Who is calling — **a ticket or an API token**, resolved the same way MCP resolves one.
     *
     * Every door in this service goes through here: requests, `/_describe`, and the event stream at
     * both subscribe and heartbeat. It resolved tickets only, which made the agent/person
     * distinction true of the MCP door and false of every one of these — the same token
     * authenticated over MCP and was anonymous here, so the CLI could not use the credential the
     * platform issues to programs (roadmap D10).
     */
    private async resolve(credential: string | undefined): Promise<Caller | undefined> {
        return await resolveCaller(credential, {
            ...(this.tickets === undefined ? {} : { tickets: this.tickets }),
            call: (tool: string, params: unknown, options: { meta: Record<string, unknown> }) =>
                this.call<unknown>(tool, params, options),
        });
    }

    private async call<T>(tool: string, params: unknown, options?: unknown): Promise<T> {
        if (this.broker === undefined) throw new MeshError('The api is not started.');
        return await (this.broker as unknown as {
            call(tool: string, params: unknown, options?: unknown): Promise<T>;
        }).call(tool, params, options);
    }
}

// ---------------------------------------------------------------------------- request pieces

/** A schema for a thing with no input. Shared, because a new one per subscription is waste. */
const emptySchema = z.object({});

/**
 * A stand-in contract, so the gate can refuse a subscription the same way it refuses a call.
 *
 * `executeGate` takes a contract because its messages name one — *"identity.whoami requires a valid
 * ticket"* — and an event is not a contract. Rather than a second gate that would drift from the
 * first, the event's name is wrapped in the shape the gate reads.
 *
 * The schemas are never used: nothing validates input on a subscription, because a subscription has
 * none. Only `domain` and `action` are read, for the message.
 */
function streamPseudoContract(eventName: string): Parameters<typeof executeGate>[0]['contract'] {
    const dot = eventName.lastIndexOf('.');
    return {
        domain: dot === -1 ? 'event' : eventName.slice(0, dot),
        action: dot === -1 ? eventName : eventName.slice(dot + 1),
        description: `subscription to ${eventName}`,
        inputSchema: emptySchema,
        outputSchema: emptySchema,
        rest: { method: 'GET', path: EVENTS_PATH },
        print: () => eventName,
    };
}

/**
 * A stand-in contract for GET /api/_describe, so the gate can evaluate the descriptor endpoint.
 */
function describePseudoContract(): Parameters<typeof executeGate>[0]['contract'] {
    return {
        domain: 'api',
        action: 'describe',
        description: 'site exposure descriptor',
        inputSchema: emptySchema,
        outputSchema: emptySchema,
        rest: { method: 'GET', path: DESCRIBE_PATH },
        print: () => 'api.describe',
    };
}

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
