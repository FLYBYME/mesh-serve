import http from 'node:http';

import { isMeshError, MeshError } from '@flybyme/mesh';
import type { ContractDeclaration, Database, IServiceBroker, IServiceToolRegistry, z } from '@flybyme/mesh';
import { ACTIVITY_RETENTION_DAYS, outcomeOf, shouldRecord, summarizeInput } from './methods/activity.js';
import type { activitySchema } from './schema/activity.js';
import './contracts/activity.contract.js';

import { type Expose } from './contracts/expose.contract.js';
import { buildDescriptor, streamableFrom, API_BASE } from './methods/descriptor.js';
import { firstOperator } from './methods/queryRule.js';
import { EventHub, openStream, type Omitted, type Subscriber } from './methods/events.js';
import { matchPath, specificity } from './methods/route.js';
import type { Api } from './contracts/api.contract.js';
import { answerHealth } from './health.js';
import { Recent } from './recent.js';

/** Expose rows read per call. Any size works -- the loop reads until a short page -- this one makes it one call for any real api. */
const EXPOSE_PAGE = 500;

/** The most any call's request body may be: far above a real record create or update. */
export const BODY_LIMIT_BYTES = 1024 * 1024;
/** The calls that carry more: a whole build, base64, for serve.artifact.importBuild. */
const LARGE_BODY_LIMITS: Readonly<Record<string, number>> = {
    'serve.artifact.importBuild': 32 * 1024 * 1024,
};

export function bodyLimitFor(contract: string): number {
    return LARGE_BODY_LIMITS[contract] ?? BODY_LIMIT_BYTES;
}

interface Caller {
    readonly userId: string;
    /** True when auth came from an api token rather than a person's ticket -- see resolveCaller. */
    readonly viaApiToken: boolean;
    /** The api token's own name, when viaApiToken. Absent for a person; that absence is meaningful. */
    readonly agentName?: string;
    /** Informational only (a held call's frozen requestedBy, display) -- never trusted for a gate
     *  decision; checkGate always re-resolves fresh. */
    readonly roles: readonly string[];
}

/** The organization a request names: the `x-organization` header, or `?organization=` (an EventSource cannot set headers). */
export function namedOrganization(req: Pick<http.IncomingMessage, 'headers' | 'url'>): string | undefined {
    const header = req.headers['x-organization'];
    const fromHeader = Array.isArray(header) ? header[0] : header;
    const value = fromHeader ?? new URL(req.url ?? '/', 'http://localhost').searchParams.get('organization') ?? undefined;
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/** The JSON Schema `type`s one property of an input schema allows, through `anyOf`/`oneOf` (an optional or nullable field). */
function typesOf(property: unknown): string[] {
    if (typeof property !== 'object' || property === null) return [];
    const p: Record<string, unknown> = { ...property };
    const own = typeof p.type === 'string' ? [p.type] : Array.isArray(p.type) ? p.type.filter((t): t is string => typeof t === 'string') : [];
    const nested = [p.anyOf, p.oneOf].flatMap((list) => (Array.isArray(list) ? list.flatMap(typesOf) : []));
    return [...own, ...nested];
}

/**
 * A GET or DELETE input, its scalar strings turned into the numbers and booleans the contract's
 * input schema declares. A query string has only strings: `k8s.logs?lines=100` reached the tool as
 * `lines: "100"` and was refused ("lines: Expected number, received string", 2026-09-30) -- every
 * GET contract with a number or boolean field failed over HTTP; only CRUD finds worked, their paging
 * fields coercing themselves. Only a field the schema types as number/integer/boolean is touched,
 * and only when the string is one exactly: a string field that looks numeric (a zone name, a key)
 * stays a string.
 */
export function typedQueryValues(input: Record<string, unknown>, inputSchema: Record<string, unknown>): Record<string, unknown> {
    const properties = typeof inputSchema.properties === 'object' && inputSchema.properties !== null
        ? Object.fromEntries(Object.entries(inputSchema.properties)) : {};
    const out: Record<string, unknown> = { ...input };
    for (const [key, value] of Object.entries(input)) {
        if (typeof value !== 'string') continue;
        const types = typesOf(properties[key]);
        if (types.includes('string')) continue;
        if ((types.includes('number') || types.includes('integer')) && /^-?\d+(\.\d+)?$/.test(value)) out[key] = Number(value);
        else if (types.includes('boolean') && (value === 'true' || value === 'false')) out[key] = value === 'true';
    }
    return out;
}

interface Route {
    readonly row: Expose;
    readonly contract: ContractDeclaration;
    readonly params: Record<string, string>;
}

/** What one call learned on its way through, for the activity log -- filled in as it goes. */
interface CallTrace {
    readonly startedAt: number;
    caller?: Caller;
    organizationId?: string;
    input?: Record<string, unknown>;
}

interface Target {
    readonly host: string;
    readonly tenantId: string;
    readonly rows: readonly Expose[];
}

/**
 * The REST/SSE gateway: one cohesive thing that owns an `http.Server`, which is why it stays a
 * class -- the same reasoning as `cdn/gateway.ts`. Dropping `ServiceModule` was about removing the
 * *tool-grouping* class, the bag that made unrelated contracts share a lifecycle. This holds no
 * contracts at all; `serve.api.listen` constructs it, and that contract's `ctx.signal` stops it.
 *
 * It deliberately does not seed the bootstrap api. That used to happen in `onStart` and was a
 * hidden ordering dependency -- it calls `identity.organization.find_one`, so starting this before
 * identity was mounted threw outright, which is exactly the coupling independently-placed parts
 * exist to remove. `bootstrap` calls `ensureBootstrapApi` once, at the moment that genuinely owns
 * creating it.
 */
export class ApiGateway {
    private server?: http.Server;
    private readonly hub: EventHub;
    /** Open `/events` subscriptions -- closed by `stop()`, since a stream never ends on its own. */
    private readonly streams = new Set<{ close(reason?: string): void }>();

    // Reused answers (recent.ts says why). What each costs:
    /** Which api a host is, and its exposed rows: an exposure change applies within 10 s. */
    private readonly targets = new Recent<Target>(10_000);
    /** Who a bearer token is: a ticket revoked elsewhere still works for up to 15 s. A sign-out through this gateway is forgotten at once. */
    private readonly callers = new Recent<Caller | undefined>(15_000);
    /** Whether a user holds a role in a tenant: a revoked role still works for up to 15 s. */
    private readonly roles = new Recent<boolean>(15_000);
    /** Each account's organizations (callOrganization), as briefly as a role. */
    private readonly memberOf = new Recent<readonly string[]>(15_000);
    /** Each target's descriptor, built once rather than on every request (it hashes every schema). */
    private readonly descriptors = new WeakMap<Target, ReturnType<typeof buildDescriptor>>();
    private readonly unsubscribes: (() => void)[] = [];

    constructor(private readonly broker: IServiceBroker) {
        this.hub = new EventHub(broker);
    }

    /** Binds and resolves once listening -- the returned address is what the contract reports. */
    public async start(port?: number, host?: string): Promise<string> {
        const SERVER_PORT = port ?? parseInt(process.env.API_PORT || '5005', 10);
        const SERVER_HOST = host ?? (process.env.SERVER_HOST || '::');

        this.server = http.createServer(async (req, res) => {
            /**
             * `*`, not the caller's own `Origin` reflected back: this api is meant to be called from
             * whichever site's `serve.expose` rows grant it, a set that changes at runtime and isn't
             * knowable statically here, and there is no cookie/credential a wildcard origin would
             * expose -- every call carries its own bearer token, the same reasoning
             * `auth/extension.ts` (mesh-core) already gives for staying bearer-only instead of a
             * cookie: *"to avoid the CSRF surface a cookie creates."* No CORS handling existed here
             * at all before this -- found live, the first time a real browser (rather than curl or a
             * same-process CLI, neither of which enforce CORS) called this api from a different
             * origin.
             */
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
            // Without this, `fetch()` silently withholds x-exposure-shape from response.headers on
            // any cross-origin call (site and api are almost always different hosts) -- DevTools'
            // Network tab still shows the raw header regardless of CORS, which is what made this
            // easy to miss live: it "looked" present while client.ts's own staleness check
            // (net/client.ts:166) never actually saw it, silently disabling the exact detection
            // that comment's own history says was already found broken once before, differently.
            res.setHeader('Access-Control-Expose-Headers', 'x-exposure-shape');
            // A browser asks permission (OPTIONS) before each distinct cross-origin call; this lets
            // it keep the answer for 10 minutes instead of paying a second round trip every time.
            res.setHeader('Access-Control-Max-Age', '600');
            if ((req.method ?? 'GET').toUpperCase() === 'OPTIONS') {
                res.statusCode = 204;
                res.end();
                return;
            }

            try {
                this.broker.logger.debug(`${req.method} ${req.url}`);
                if (await answerHealth(this.broker, req, res)) return;
                await this.handleRequest(req, res);
            } catch (err) {
                // isMeshError, not instanceof: this gateway runs from a precompiled .cjs part,
                // which under tsx is a different copy of @flybyme/mesh than the broker handing it
                // the error -- so instanceof answered false for a real MeshError and every
                // meaningful status became a 500. See MESH_ERROR_BRAND.
                if (isMeshError(err)) {
                    res.statusCode = err.status;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: err.message }));
                } else if (err instanceof Error && err.message.includes('Local tool not found')) {
                    // A contract can be exposed (mesh-level public, a real serve.expose row) and
                    // still have nothing backing it right now -- a serve.part.stop'd service, most
                    // concretely, but the same is true of any tool nothing in the cluster currently
                    // mounts. That's a real, expected runtime state, not a server bug; the plain
                    // Error @flybyme/mesh throws for it isn't a MeshError, so it fell through to the
                    // generic 500 below with no detail, found live stopping a real service.
                    res.statusCode = 503;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: err.message }));
                } else {
                    this.broker?.logger.error('Error handling api request', err);
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'Internal Server Error' }));
                }
                this.broker.logger.debug(`Response: ${res.statusCode} ${res.statusMessage}`);
            }
        });

        this.server.on('error', (err) => {
            this.broker?.logger.error('Api server error', err);
        });

        // An exposure or api changed: the next request reads it fresh, so the 10 s a target is kept
        // only bounds a change this node did not hear about.
        for (const name of ['serve.expose', 'serve.api'].flatMap((d) => [`${d}.created`, `${d}.updated`, `${d}.deleted`])) {
            this.unsubscribes.push(this.hub.subscribe(name, () => this.targets.clear()));
        }

        await new Promise<void>((resolve, reject) => {
            this.server?.listen(SERVER_PORT, SERVER_HOST, () => resolve());
            this.server?.once('error', reject);
        });

        // The port actually bound -- SERVER_PORT is only what was asked for (0 means "any").
        const bound = this.server.address();
        const boundPort = bound !== null && typeof bound === 'object' ? bound.port : SERVER_PORT;
        this.broker?.logger.info(`Api server running at ${SERVER_HOST}:${boundPort}`);
        return `${SERVER_HOST}:${boundPort}`;
    }

    /** Called from `serve.api.listen`'s abort handler -- nothing else stops this. */
    public async stop(): Promise<void> {
        // `server.close` waits for every open connection to end, and a subscription never ends by
        // itself -- without this, stopping the api with one browser tab open hung forever.
        for (const stream of [...this.streams]) stream.close('the api is stopping');
        for (const off of this.unsubscribes.splice(0)) off();
        if (this.server) {
            this.server.closeIdleConnections?.();
            await new Promise((resolve) => this.server?.close(resolve));
            this.server = undefined;
        }
    }

    private async resolveHostname(req: http.IncomingMessage): Promise<string> {
        // A route through the edge proxy connects to this node's own upstream address (e.g.
        // 127.0.0.1:5005), not the public hostname a client actually typed -- Node's http.request
        // sets the outgoing Host header to whatever address it's connecting to, unless told
        // otherwise. The proxy already sends the real one separately, the standard way
        // (x-forwarded-host, set from surfdns-proxy/src/services/wire/gateway.ts); prefer it,
        // falling back to Host for a direct, unproxied hit (e.g. this node's own --publicApiPort).
        // Found live: every request through a real route resolved to "No api for host 127.0.0.1"
        // instead of the api the client actually asked for.
        const forwardedHost = req.headers['x-forwarded-host'];
        const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? req.headers.host;
        if (host === undefined) {
            throw new MeshError({ code: 'Bad Request', message: 'No host header', status: 400 });
        }
        const [hostname] = host.split(':');
        if (hostname === undefined) {
            throw new MeshError({ code: 'Bad Request', message: 'No hostname', status: 400 });
        }
        return hostname;
    }

    private async resolveApi(hostname: string): Promise<Api> {
        const api = await this.broker.call('serve.api.resolveByHost', { apiHost: hostname });
        if (api === undefined) {
            throw new MeshError({ code: 'Not Found', message: `No api for host "${hostname}".`, status: 404 });
        }
        return api;
    }

    /**
     * This runs before any caller is known, but resolveCallerScope (DatabaseMiddleware.js) doesn't
     * actually need a caller -- it falls back to a bare meta.tenant_id when meta.user is absent. The
     * api we already resolved names its own tenant, so that's what scopes this read: no bypass, no
     * caller required, just the tenant context this request is already known to be serving.
     */
    private async resolveExposeRows(apiId: string, tenantId: string): Promise<Expose[]> {
        // Every row, page by page. `find` returns 100 rows unless told otherwise, and reading only
        // those silently unexposed whatever sorted after them: the 101st row exposed on
        // api.surfdns.net took serve.part.update and serve.repo.* off the api, with no error anywhere.
        const rows: Expose[] = [];
        for (let offset = 0; ; offset += EXPOSE_PAGE) {
            const page = await this.broker.call('serve.expose.find', { query: { apiId }, limit: EXPOSE_PAGE, offset }, { meta: { tenant_id: tenantId } });
            rows.push(...page);
            if (page.length < EXPOSE_PAGE) return rows;
        }
    }

    private resolveTarget(hostname: string): Promise<Target> {
        return this.targets.get(hostname, async () => {
            const api = await this.resolveApi(hostname);
            return { host: api.apiHost, tenantId: api.tenantId, rows: await this.resolveExposeRows(api.id, api.tenantId) };
        });
    }

    private describe(target: Target): ReturnType<typeof buildDescriptor> {
        let descriptor = this.descriptors.get(target);
        if (descriptor === undefined) {
            descriptor = buildDescriptor(target.host, target.rows, (key) => this.broker.contractDeclaration(key));
            this.descriptors.set(target, descriptor);
        }
        return descriptor;
    }

    /** One user's role in one tenant, as identity answers it -- reused for 15 s (see `roles`). */
    /**
     * The organization a call runs in -- the boundary between customers.
     *
     * Until 2026-10-01 every call ran in the api's own organization (the platform's), whoever made
     * it: only `role: operator` on every member page's exposure row kept a customer from reading the
     * platform's zones and mail. Now:
     * - anonymous, or a public call (no gate on the row or the contract): the api's own, as before
     *   -- a public call acts for the api's owner whoever makes it (login, the contact form);
     * - an operator: the api's own, as before (resolveEffectiveTenantId may still redirect it);
     * - anyone else: one of their own organizations -- named by the `x-organization` header (or
     *   `?organization=`, for an EventSource, which cannot set headers), or their only one --
     *   checked against identity.membership on every call. Never one they are not a member of, and
     *   never the api's own unless they are a member of it.
     */
    private async callOrganization(req: http.IncomingMessage, gated: boolean, caller: Caller | undefined, apiTenantId: string): Promise<string> {
        if (caller === undefined || !gated) return apiTenantId;
        if (await this.holdsRole(caller.userId, 'operator', apiTenantId)) return apiTenantId;
        const theirs = await this.organizationsOf(caller.userId);
        const named = namedOrganization(req);
        if (named !== undefined) {
            if (!theirs.includes(named)) {
                throw new MeshError({ message: 'You are not a member of that organization.', code: 'FORBIDDEN', status: 403 });
            }
            return named;
        }
        if (theirs.length === 1) return theirs[0]!;
        if (theirs.length === 0) {
            throw new MeshError({ message: 'This account belongs to no organization yet.', code: 'FORBIDDEN', status: 403 });
        }
        throw new MeshError({
            message: 'This account belongs to several organizations: name one with the x-organization header.',
            code: 'BAD_REQUEST', status: 400,
        });
    }

    /**
     * One row in the activity log, when this call is one it keeps (methods/activity.ts). Never
     * waits and never fails the call: a log write that fails is logged and the call stands.
     */
    private recordActivity(target: Target, route: Route, req: http.IncomingMessage, trace: CallTrace, status: number, error?: string): void {
        const outcome = outcomeOf(status);
        if (!shouldRecord(route.contract, outcome)) return;
        const header = (name: string): string | undefined => {
            const value = req.headers[name];
            const first = Array.isArray(value) ? value[0] : value;
            return first === undefined || first === '' ? undefined : first.slice(0, 200);
        };
        const forwardedFor = header('x-forwarded-for');
        const userAgent = header('user-agent');
        const row = {
            at: new Date(trace.startedAt),
            apiId: route.row.apiId,
            contract: route.row.contract,
            organizationId: trace.organizationId ?? target.tenantId,
            actor: {
                userId: trace.caller?.userId ?? '',
                viaApiToken: trace.caller?.viaApiToken ?? false,
                ...(trace.caller?.agentName !== undefined ? { agentName: trace.caller.agentName } : {}),
            },
            outcome,
            status,
            ...(error !== undefined && outcome !== 'ok' ? { error: error.slice(0, 300) } : {}),
            input: summarizeInput(trace.input),
            durationMs: Math.max(0, Date.now() - trace.startedAt),
            ip: req.socket.remoteAddress ?? '',
            ...(forwardedFor !== undefined ? { forwardedFor } : {}),
            ...(userAgent !== undefined ? { userAgent } : {}),
        };
        void this.writeActivity(row).catch((err: unknown) => {
            this.broker.logger.warn(`[api] activity not recorded for ${route.row.contract}: ${err instanceof Error ? err.message : String(err)}`);
        });
    }

    /** Rows expire on their own: a TTL index on `at`, ensured once per process. */
    private activityIndex: Promise<void> | undefined;

    private async writeActivity(row: z.input<typeof activitySchema>): Promise<void> {
        this.activityIndex ??= this.broker.getProvider<Database>('database').getCollection('serve.activity')
            .createIndex({ at: 1 }, { name: 'activity_expiry', expireAfterSeconds: ACTIVITY_RETENTION_DAYS * 86_400 })
            .then(() => undefined, (err: unknown) => {
                this.activityIndex = undefined;
                throw err;
            });
        await this.activityIndex;
        await this.broker.call('serve.activity.create', row);
    }

    /** The organizations an account is a member of, by id; kept as briefly as a role answer. */
    private organizationsOf(userId: string): Promise<readonly string[]> {
        return this.memberOf.get(userId, async () => {
            const who = await this.broker.call('identity.whoami', {}, { meta: { user: { id: userId, tenant_id: '', organizationId: '' } } });
            return who.organizations.map((o) => o.organizationId);
        });
    }

    private holdsRole(userId: string, role: string, tenantId: string): Promise<boolean> {
        return this.roles.get(`${userId}\u0000${role}\u0000${tenantId}`, async () => {
            // The same meta checkGate always sent -- see its comment for why organizationId too.
            const meta = { user: { id: userId, tenant_id: tenantId, organizationId: tenantId } };
            const result = await this.broker.call('identity.hasRole', { userId, role, organizationId: tenantId }, { meta });
            return result.granted;
        });
    }

    private bearer(req: http.IncomingMessage): string | undefined {
        const header = req.headers.authorization;
        if (header === undefined || !header.startsWith('Bearer ')) return undefined;
        const token = header.slice('Bearer '.length).trim();
        return token === '' ? undefined : token;
    }

    /**
     * Bearer token could be a user ticket or an api token -- there is no prefix marking which, so
     * both are tried. Absent or unrecognized means anonymous, not an error: whether that's good
     * enough is the gate step's job, not this one's. `roles` here is carried along for display only
     * (a held call's frozen `requestedBy.roles`) and never trusted for a gate decision -- that
     * always re-resolves fresh from identity.role/identity.membership, in checkGate, on every call.
     * `viaApiToken`/`agentName` distinguish a person from an agent: placeOnHold (below) is the
     * one place that distinction actually matters.
     */
    private resolveCaller(req: http.IncomingMessage): Promise<Caller | undefined> {
        const token = this.bearer(req);
        if (token === undefined) return Promise.resolve(undefined);
        // Only a token that resolved to someone is kept: an unknown one is asked about every time,
        // so a ticket issued a moment ago is never refused for 15 s.
        return this.callers.get(token, () => this.lookUpCaller(token), (caller) => caller !== undefined);
    }

    private async lookUpCaller(token: string): Promise<Caller | undefined> {
        const ticket = await this.broker.call('identity.ticket.validate', { token });
        if (ticket.valid && ticket.userId !== undefined) {
            return { userId: ticket.userId, viaApiToken: false, roles: ticket.roles ?? [] };
        }

        const apiToken = await this.broker.call('identity.apiToken.validate', { token });
        if (apiToken.valid && apiToken.userId !== undefined) {
            return {
                userId: apiToken.userId, viaApiToken: true, agentName: apiToken.name,
                roles: apiToken.roles ?? [],
            };
        }

        return undefined;
    }

    /**
     * Finds the one exposed row+contract matching this request. A row naming a gone or non-public
     * contract is skipped rather than 500ing -- the same "reject internal" defense in depth as
     * methods/descriptor.ts's buildDescriptor, checked again here rather than trusted from there.
     *
     * Every contract path is written without the API_BASE prefix (e.g. "/identity/ticket"), matching
     * buildDescriptor's advertised `base` -- so the prefix has to come off the real request path
     * before matchPath compares them, or every generated client's calls would 404 while only the
     * hardcoded "/api/_describe" special case worked.
     */
    private findRoute(rows: readonly Expose[], req: http.IncomingMessage): Route | undefined {
        const method = (req.method ?? 'GET').toUpperCase();
        const fullPath = (req.url ?? '/').split('?')[0] ?? '/';
        if (!fullPath.startsWith(API_BASE)) return undefined;
        const urlPath = fullPath.slice(API_BASE.length) || '/';

        // The most specific match, not the first: /repos/one must reach find_one even when the
        // row for get (/repos/:id) was added earlier.
        let best: Route | undefined;
        for (const row of rows) {
            if (row.kind === 'event') continue; // Streamed over /events, never called.
            // This node's definition, or the one the node running it advertises: routing needs the
            // declaration (method, path, who may call), not the implementation.
            const contract = this.broker.contractDeclaration(row.contract);
            if (contract === undefined) {
                // Neither defined here nor advertised by any available peer. Skipping silently turns
                // that into a bare 404 that looks identical to a wrong URL, so say so.
                this.broker.logger.warn(`serve.api: "${row.contract}" is exposed on ${row.apiId} but no node declares it, so nothing can route to it.`);
                continue;
            }
            if (contract.visibility !== 'public') continue;
            if (contract.rest.method !== method) continue;

            const params = matchPath(contract.rest.path, urlPath);
            if (params !== undefined && (best === undefined || specificity(contract.rest.path) > specificity(best.contract.rest.path))) {
                best = { row, contract, params };
            }
        }
        return best;
    }

    /**
     * role is a coarse, direct role check (identity.hasRole); permission calls identity.permits, a
     * finer check against the role's own permission patterns. Both resolve the caller's effective
     * roles fresh, combining global account roles with their membership role in this target's own
     * tenant -- account roles are king, so a membership role can never stand in for a global one.
     * Neither role nor permission set on the row means public. No caller at all is only a problem
     * once the row actually demands one.
     */
    private async checkGate(
        row: Expose,
        contract: ContractDeclaration,
        caller: Caller | undefined,
        tenantId: string,
    ): Promise<void> {
        // The contract's own floor, applied before the row's. This is the half that fails *safe*:
        // an expose row with no role is anonymous, so before this a destructive contract published
        // without one was reachable by anybody, and nothing anywhere said that was a mistake.
        // Declaring the requirement on the contract means a wrong expose row can now only
        // over-restrict. The row stays extrinsic and may still demand more -- both apply.
        const required = contract.permissions;

        if (required.length === 0 && row.role === undefined && row.permission === undefined) {
            return;
        }

        if (caller === undefined) {
            throw new MeshError({ message: 'Authentication required.', code: 'UNAUTHORIZED', status: 401 });
        }

        // identity.membership is scopedBy: 'organizationId', not 'tenantId' like every other
        // collection here -- hasRole/permits resolve that account's own membership internally via
        // ctx.call, which inherits whatever meta this entry call carries, so organizationId has to
        // be set here too, aliasing the same value tenant_id already carries.
        const meta = { user: { id: caller.userId, tenant_id: tenantId, organizationId: tenantId } };

        // Every declared key, not any -- a contract asking for two roles means both. Sequential
        // rather than parallel so the message names the first one actually missing, which is the
        // one an operator has to grant.
        for (const roleKey of required) {
            if (!(await this.holdsRole(caller.userId, roleKey, tenantId))) {
                throw new MeshError({
                    message: `"${row.contract}" requires role "${roleKey}".`,
                    code: 'FORBIDDEN',
                    status: 403,
                });
            }
        }

        if (row.role !== undefined) {
            if (!(await this.holdsRole(caller.userId, row.role, tenantId))) {
                throw new MeshError({ message: `Requires role "${row.role}".`, code: 'FORBIDDEN', status: 403 });
            }
        }

        if (row.permission !== undefined) {
            const result = await this.broker.call('identity.permits', {
                userId: caller.userId,
                contract: row.contract,
                organizationId: tenantId,
            }, { meta });
            if (!result.permitted) {
                throw new MeshError({ message: `Not permitted to call "${row.contract}".`, code: 'FORBIDDEN', status: 403 });
            }
        }
    }

    /**
     * Every scoped-by-tenantId collection's create/find/etc. is normally locked to the api being
     * called through (DatabaseMiddleware's own createData[scopedBy] = callerScope, unconditional --
     * mesh is frozen, this is not a place to patch). That lock is what stops any caller from writing
     * into a tenant they didn't call through, and it must stay unconditional for everyone else.
     *
     * The one deliberate exception: identity.hasRole treats account-level roles ("operator") as king,
     * applying everywhere regardless of which org you're calling through (methods/roles.ts). An
     * operator naming an explicit tenantId in the request body is trusted the same way -- checked
     * fresh, every call, against the *account* role (never a membership role, which could be
     * tenant-local and forged-adjacent by joining the wrong org). A non-operator's tenantId field is
     * silently ignored, not rejected, so this can never turn into a signal an attacker can probe.
     */
    private async resolveEffectiveTenantId(
        caller: Caller | undefined,
        targetTenantId: string,
        input: Record<string, unknown>,
    ): Promise<string> {
        if (caller === undefined) return targetTenantId;

        const requested = input.tenantId;
        if (typeof requested !== 'string' || requested === '' || requested === targetTenantId) {
            return targetTenantId;
        }

        return (await this.holdsRole(caller.userId, 'operator', targetTenantId)) ? requested : targetTenantId;
    }

    /**
     * The whole body, at most `limit` bytes. It used to read any size into memory, so one huge
     * request -- to a public call like login, which needs no ticket -- could run a node out of
     * memory and take every part on it down (roadmap, 2026-09-28). Refused on the declared length
     * before a byte is read; otherwise counted as it arrives, and past the limit the rest is
     * drained unkept. Decoded once at the end: decoding chunk by chunk split a multi-byte
     * character that straddled two chunks.
     */
    private readBody(req: http.IncomingMessage, limit: number): Promise<string> {
        const tooLarge = (): MeshError => new MeshError({
            message: `Request body larger than ${limit} bytes.`, code: 'PAYLOAD_TOO_LARGE', status: 413,
        });
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > limit) {
            req.resume();
            return Promise.reject(tooLarge());
        }
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            let size = 0;
            const onData = (chunk: Buffer): void => {
                size += chunk.length;
                if (size > limit) {
                    req.off('data', onData);
                    req.resume();
                    reject(tooLarge());
                    return;
                }
                chunks.push(chunk);
            };
            req.on('data', onData);
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
            req.on('error', reject);
        });
    }

    /**
     * `mesh-web/net`'s own `toRequest` (the encoding side of this) JSON-stringifies any object or
     * array input value into its GET query string -- `query: { partId }` becomes `?query=%7B...%7D`,
     * a CrudParamsSchema `fields`/`sort` array becomes `?fields=%5B...%5D` -- because a `URLSearchParams`
     * value can only ever be a plain string. This is the decode half, and until now it did not exist:
     * every value came back as the raw string, so any find/find_one call that actually needed a
     * `query` filter (or a multi-value `fields`/`sort`) over real HTTP failed schema validation
     * ("Expected object, received string") -- found live wiring `mesh-serve init`'s build-status poll
     * (`serve.artifact.find` with `{ query: { partId } }`) through the CLI's real generated-style
     * client for the first time; every find call before this either passed no filter at all or was
     * made through an in-process `ctx.call`, which never serializes to a query string to begin with.
     * A plain string that only looks numeric or boolean is left alone -- only a value that actually
     * round-trips to an object or array is treated as intentionally encoded, so an ordinary scalar
     * filter (a `contract` key, a `host`) is never misinterpreted.
     */
    private decodeQueryValue(value: string): unknown {
        if (value.length === 0 || (value[0] !== '{' && value[0] !== '[')) return value;
        try {
            const parsed: unknown = JSON.parse(value);
            return typeof parsed === 'object' && parsed !== null ? parsed : value;
        } catch {
            return value;
        }
    }

    private async parseInput(req: http.IncomingMessage, params: Record<string, string>, bodyLimit: number, inputSchema: Record<string, unknown>): Promise<Record<string, unknown>> {
        const method = (req.method ?? 'GET').toUpperCase();
        const read = await this.readInput(req, params, bodyLimit);
        // A query string carries only strings: typed by the contract's own input schema.
        const input = method === 'GET' || method === 'DELETE' ? typedQueryValues(read, inputSchema) : read;
        // Equality only from the outside -- see methods/queryRule.ts.
        const operator = firstOperator(input['query']);
        if (operator !== undefined) {
            throw new MeshError({
                message: `Query operators are not accepted over the api (${operator}): a query is field equality only.`,
                code: 'BAD_REQUEST', status: 400,
            });
        }
        return input;
    }

    private async readInput(req: http.IncomingMessage, params: Record<string, string>, bodyLimit: number): Promise<Record<string, unknown>> {
        const method = (req.method ?? 'GET').toUpperCase();

        if (method === 'GET' || method === 'DELETE') {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const query: Record<string, unknown> = {};
            for (const [key, value] of url.searchParams) {
                query[key] = this.decodeQueryValue(value);
            }
            return { ...query, ...params };
        }

        const raw = await this.readBody(req, bodyLimit);
        if (raw.trim() === '') {
            return { ...params };
        }

        let body: unknown;
        try {
            body = JSON.parse(raw);
        } catch {
            throw new MeshError({ message: 'Malformed JSON body.', code: 'BAD_REQUEST', status: 400 });
        }
        if (typeof body !== 'object' || body === null) {
            throw new MeshError({ message: 'Body must be a JSON object.', code: 'BAD_REQUEST', status: 400 });
        }

        return { ...(body as Record<string, unknown>), ...params };
    }

    /**
     * `GET /api/events[?events=a,b]`: a Server-Sent Events subscription to this api's exposed events
     * (`serve.expose` rows of kind `event`), or the named subset of them.
     *
     * Each event's gate is checked once here, like a call's. What the caller cannot receive -- not
     * exposed, not deliverable from this node, a role they lack -- is named in a
     * `subscription.omitted` event before anything else; if that is *everything*, the request is
     * refused outright with the reasons, never accepted into a stream that stays silent.
     */
    private async handleEvents(target: Target, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const rows = target.rows.filter((row) => row.kind === 'event');
        if (rows.length === 0) {
            throw new MeshError({ message: `No events are streamed on ${target.host}.`, code: 'NOT_FOUND', status: 404 });
        }

        const requested = new URL(req.url ?? '/', 'http://localhost').searchParams.get('events');
        const wanted = requested === null ? undefined : new Set(requested.split(',').map((name) => name.trim()).filter((name) => name !== ''));

        const caller = await this.resolveCaller(req);
        const events: string[] = [];
        const omitted: Omitted[] = [];

        // Asked once per role, not once per event (`holdsRole` shares one answer). Nearly every
        // event row names the same role (`operator`), and asking identity again for each, one after
        // another, held the stream's first byte back ~16 s with 55 events on api.surfdns.net
        // (2026-09-29) -- a page that counted itself live missed everything written in that time.
        // A member's stream is their own organization's, as a member's call is (callOrganization);
        // anonymous and operators keep the api's own.
        const scopeOf = (who: Caller | undefined): Promise<string> => this.callOrganization(req, true, who, target.tenantId)
            .catch((err: unknown) => { if (who === undefined) return target.tenantId; throw err; });
        const scope = await scopeOf(caller);
        const holds = (who: Caller, role: string): Promise<boolean> => this.holdsRole(who.userId, role, scope);

        for (const name of wanted ?? []) {
            if (!rows.some((row) => row.contract === name)) omitted.push({ name, reason: 'not streamed on this api' });
        }
        for (const row of rows) {
            const name = row.contract;
            if (wanted !== undefined && !wanted.has(name)) continue;
            if (!streamableFrom(name)) {
                omitted.push({ name, reason: 'this node has no definition of it that can be scoped to a subscriber' });
                continue;
            }
            if (row.role !== undefined) {
                if (caller === undefined) {
                    omitted.push({ name, reason: `requires role "${row.role}" -- not signed in` });
                    continue;
                }
                if (!(await holds(caller, row.role))) {
                    omitted.push({ name, reason: `requires role "${row.role}"` });
                    continue;
                }
            }
            events.push(name);
        }

        if (events.length === 0) {
            const reasons = omitted.map((entry) => `${entry.name}: ${entry.reason}`).join('; ');
            throw caller === undefined && omitted.some((entry) => entry.reason.includes('not signed in'))
                ? new MeshError({ message: `Authentication required. ${reasons}`, code: 'UNAUTHORIZED', status: 401 })
                : new MeshError({ message: `Nothing here can be streamed to you. ${reasons}`, code: 'FORBIDDEN', status: 403 });
        }

        // The scope is re-read on every recheck: a member removed from the organization stops
        // receiving its events on the next beat (the recheck then fails, and the stream ends).
        const subscriberFor = async (who: Caller | undefined): Promise<Subscriber> => ({
            scope: await scopeOf(who),
            operator: who !== undefined && await this.holdsRole(who.userId, 'operator', target.tenantId),
        });

        const stream = openStream({
            res,
            events,
            omitted,
            hub: this.hub,
            // Each recheck (every heartbeat, 20 s) outlasts the 15 s the answer is kept, so a revoked
            // role or ticket still ends the stream's privileges on the next beat.
            subscriber: await subscriberFor(caller),
            // A signed-in subscription ends when its credential does; an anonymous one has nothing
            // to lose. Roles are re-read, so a revoked operator stops seeing other tenants' events.
            recheck: async () => {
                const current = await this.resolveCaller(req);
                if (caller !== undefined && current === undefined) return undefined;
                // Refused now (no longer a member of the organization it streams): end it. Any
                // other failure stays a blip, which openStream rides out.
                return subscriberFor(current).catch((err: unknown) => {
                    if (isMeshError(err) && (err.status === 403 || err.status === 400)) return undefined;
                    throw err;
                });
            },
        });
        this.streams.add(stream);
        res.on('close', () => this.streams.delete(stream));
    }


    private async handleDescribe(target: Target, res: http.ServerResponse): Promise<void> {
        const descriptor = this.describe(target);

        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(JSON.stringify(descriptor));
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const hostname = await this.resolveHostname(req);
        const target = await this.resolveTarget(hostname);

        const urlPath = (req.url ?? '/').split('?')[0];
        if (urlPath === `${API_BASE}/_describe`) {
            return this.handleDescribe(target, res);
        }
        if (urlPath === `${API_BASE}/events` && (req.method ?? 'GET').toUpperCase() === 'GET') {
            return this.handleEvents(target, req, res);
        }

        const route = this.findRoute(target.rows, req);
        if (route === undefined) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Not Found' }));
            return;
        }

        // Every call that changes something, or is refused, goes in the activity log -- whichever
        // way it ends. What the call learned on the way (who, which organization, its input) is
        // collected in `trace` so a refusal before the input is read is still recorded.
        const trace: CallTrace = { startedAt: Date.now() };
        try {
            await this.handleCall(target, route, req, res, trace);
            this.recordActivity(target, route, req, trace, res.statusCode);
        } catch (err) {
            const status = isMeshError(err) ? err.status : err instanceof Error && err.message.includes('Local tool not found') ? 503 : 500;
            this.recordActivity(target, route, req, trace, status, err instanceof Error ? err.message : String(err));
            throw err;
        }
    }

    private async handleCall(
        target: Target,
        route: Route,
        req: http.IncomingMessage,
        res: http.ServerResponse,
        trace: CallTrace,
    ): Promise<void> {
        const caller = await this.resolveCaller(req);
        trace.caller = caller;
        const gated = route.contract.permissions.length > 0 || route.row.role !== undefined || route.row.permission !== undefined;
        const organization = await this.callOrganization(req, gated, caller, target.tenantId);
        trace.organizationId = organization;
        await this.checkGate(route.row, route.contract, caller, organization);

        const input = await this.parseInput(req, route.params, bodyLimitFor(route.row.contract), route.contract.input);
        trace.input = input;

        // tenant_id is always known here -- it's the api's own owning tenant (or an operator's
        // explicit override, resolveEffectiveTenantId) -- regardless of whether the caller is.
        // meta used to be `undefined` outright for an anonymous caller, which meant a scoped
        // collection exposed with NO role/permission gate (genuinely, deliberately public) still
        // 401'd for anyone not signed in: DatabaseMiddleware requires *some* resolved scope before
        // it will even run a gate-free find, and an absent meta can never resolve one. `id: ''`
        // for an anonymous caller resolves to nothing under resolveCallerScope's own `.length > 0`
        // check, so a userId-scoped collection (e.g. identity.membership) still correctly refuses
        // anonymous access; tools like identity.whoami that need a real caller check `=== ''` too.
        // organizationId aliases tenant_id here too: identity.membership is scopedBy:
        // 'organizationId', not 'tenantId' like every other collection reached through this gateway,
        // and resolveCallerScope (DatabaseMiddleware) only ever reads the field a collection's own
        // scopedBy names -- an api-wide meta that only ever set tenant_id left membership as the one
        // collection this gateway's automatic scoping could never satisfy.
        // A member's call runs in their own organization (callOrganization); only a call running in
        // the api's own tenant -- anonymous, public, or an operator's -- may be redirected by an
        // operator's explicit tenantId.
        const effectiveTenantId = organization === target.tenantId
            ? await this.resolveEffectiveTenantId(caller, target.tenantId, input)
            : organization;
        trace.organizationId = effectiveTenantId;
        const meta = { user: { id: caller?.userId ?? '', tenant_id: effectiveTenantId, organizationId: effectiveTenantId } };

        // The agent surface: a destructive call made by an api token (never by a signed-in person's
        // ticket -- viaApiToken is exactly that distinction) is frozen and held instead of run.
        // `destructive` already exists on every contract as documentation (descriptor.ts, the CLI's
        // own help text); this is what actually makes it load-bearing. serve.hold.decide itself is
        // deliberately never marked destructive, so an operator's own decision can't recursively hold.
        if (caller?.viaApiToken === true && route.contract.destructive === true) {
            const held = await this.placeOnHold(route, caller, target, input, effectiveTenantId);
            res.setHeader('Content-Type', 'application/json');
            res.statusCode = 202;
            res.end(JSON.stringify(held));
            return;
        }

        // route.row.contract is a domain.action key validated at runtime (findRoute already
        // confirmed a public declaration for it, here or advertised) -- the broker's
        // own generic can't know that statically, so this crosses the boundary the same way mesh's
        // own generated CLI does for identical dynamic dispatch.
        // The contract's own timeout, not the broker's 10 s default: machine.import (declared 30
        // minutes, running on surf) answered 500 here while the import carried on.
        const timeout = route.contract.timeout;
        const result = await this.broker.call(route.row.contract as keyof IServiceToolRegistry, input as never, { meta, ...(timeout !== undefined ? { timeout } : {}) });

        // A sign-out through this gateway ends the ticket here at once, not after the 15 s it is kept.
        if (route.row.contract === 'identity.ticket.signOut') {
            if (typeof input.token === 'string') this.callers.forget(input.token);
            const token = this.bearer(req);
            if (token !== undefined) this.callers.forget(token);
        }

        res.setHeader('x-exposure-shape', this.describe(target).shapeHash);
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(JSON.stringify(result));
    }

    /** How long a held call waits before it's treated as expired. Not enforced by a timer --
     *  read paths (serve.hold.find/get) would need to compute this lazily; there's no such check
     *  yet, so a row simply never actually flips to 'expired' today. Flagged as a gap. */
    private static readonly HOLD_TTL_MS = 24 * 60 * 60 * 1000;

    private async placeOnHold(
        route: Route,
        caller: Caller,
        target: Target,
        input: Record<string, unknown>,
        tenantId: string,
    ): Promise<unknown> {
        const now = Date.now();
        return this.broker.call('serve.hold.create', {
            tenantId,
            call: route.row.contract,
            host: target.host,
            input,
            requestedBy: { userId: caller.userId, agent: caller.agentName, roles: [...caller.roles] },
            requestedAt: new Date(now),
            status: 'held',
            expiresAt: new Date(now + ApiGateway.HOLD_TTL_MS),
        }, { meta: { tenant_id: tenantId } });
    }
}
