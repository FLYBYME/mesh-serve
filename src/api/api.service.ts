import http from 'node:http';

import { globalContractRegistry, isPublicContract, MeshError, ServiceModule } from '@flybyme/mesh';
import type { IServiceBroker, IServiceToolRegistry, ToolContract } from '@flybyme/mesh';

import { exposeCrud, exposeAddContract, exposeRemoveContract, type Expose } from './contracts/expose.contract.js';
import { wantCrud } from './contracts/want.contract.js';
import { apiCrud, apiResolveByIdContract, apiResolveByHostContract } from './contracts/api.contract.js';
import { generateClientContract } from './contracts/generateClient.contract.js';
import { buildDescriptor, API_BASE } from './methods/descriptor.js';
import { matchPath } from './methods/route.js';
import { add } from './tools/add.js';
import { remove } from './tools/remove.js';
import { resolveApiById } from './tools/resolveApiById.js';
import { resolveApiByHost } from './tools/resolveApiByHost.js';
import { generateClient } from './tools/generateClient.js';
import type { Api } from './contracts/api.contract.js';

interface Caller {
    readonly userId: string;
}

interface Route {
    readonly row: Expose;
    readonly contract: ToolContract;
    readonly params: Record<string, string>;
}

interface Target {
    readonly host: string;
    readonly tenantId: string;
    readonly rows: readonly Expose[];
}

/**
 * The hostname a fresh install's bootstrap api lives on -- not special-cased in routing any more
 * (every host, including this one, resolves through the same `serve.api` lookup), just the one this
 * install creates a real `serve.api` row for automatically, attached to the "platform" organization
 * identity.service.ts creates at first boot. A literal string shared between the two files, the same
 * way the "operator" role key already is.
 */
const BOOTSTRAP_API_HOST = process.env.DEFAULT_API_HOST ?? 'api.localhost';

/**
 * Exposed on the bootstrap api the first time it's created -- how a fresh install gets anyone in at
 * all, plus the two calls that let an operator start configuring more without anything pre-seeded by
 * hand. Kept minimal on purpose: register, log in, ask who you are, set a real password. Anything
 * else goes through explicit expose rows once something needs it.
 */
const BOOTSTRAP_EXPOSED_CONTRACTS: readonly { contract: string; role?: string }[] = [
    { contract: 'identity.user.register' },
    { contract: 'identity.ticket.issue' },
    { contract: 'identity.whoami' },
    { contract: 'identity.user.setPassword' },
    { contract: 'serve.expose.add', role: 'operator' },
    { contract: 'serve.expose.remove', role: 'operator' },
];

export class ApiService extends ServiceModule {
    public readonly domain = 'serve.api';

    private server?: http.Server;
    private broker!: IServiceBroker;

    constructor() {
        super();

        this.mountCrud(apiCrud);
        this.mountCrud(exposeCrud);
        this.mountCrud(wantCrud);
        this.mountTool(apiResolveByIdContract, resolveApiById);
        this.mountTool(apiResolveByHostContract, resolveApiByHost);
        this.mountTool(exposeAddContract, add);
        this.mountTool(exposeRemoveContract, remove);
        this.mountTool(generateClientContract, generateClient);
    }

    public async onStart(broker: IServiceBroker): Promise<void> {
        this.broker = broker;
        await this.ensureBootstrapApi();
        await this.createServer();
    }

    /**
     * Checked every boot, idempotently. Relies on identity.service.ts's own onStart having already
     * created the "platform" organization this attaches to -- module registration order in start.ts
     * puts IdentityService first, so its onStart has already run by the time this does. If no such
     * organization exists yet (an install whose identity module hasn't bootstrapped, or never will),
     * this is a no-op rather than a failure: there's nothing to attach a bootstrap api to.
     */
    private async ensureBootstrapApi(): Promise<void> {
        const organization = await this.broker.call('identity.organization.find_one', { query: { slug: 'platform' } });
        if (organization === undefined) {
            return;
        }

        const meta = { tenant_id: organization.id };
        const existing = await this.broker.call('serve.api.find_one', { query: { apiHost: BOOTSTRAP_API_HOST } }, { meta });
        if (existing !== undefined) {
            return;
        }

        this.broker.logger.info(`Creating bootstrap api "${BOOTSTRAP_API_HOST}"...`);
        const api = await this.broker.call('serve.api.create', {
            tenantId: organization.id, apiHost: BOOTSTRAP_API_HOST,
        }, { meta });

        for (const { contract, role } of BOOTSTRAP_EXPOSED_CONTRACTS) {
            this.broker.logger.info(`Exposing "${contract}"${role ? ` (role: ${role})` : ''} on ${BOOTSTRAP_API_HOST}...`);
            await this.broker.call('serve.expose.create', {
                tenantId: organization.id,
                apiId: api.id,
                contract,
                ...(role !== undefined ? { role } : {}),
            }, { meta });
        }
    }

    private async createServer(): Promise<void> {
        const SERVER_PORT = parseInt(process.env.API_PORT || '5005', 10);
        const SERVER_HOST = process.env.SERVER_HOST || '::';

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
            if ((req.method ?? 'GET').toUpperCase() === 'OPTIONS') {
                res.statusCode = 204;
                res.end();
                return;
            }

            try {
                this.broker.logger.debug(`${req.method} ${req.url} ${JSON.stringify(req.headers)}`);
                await this.handleRequest(req, res);
            } catch (err) {
                if (err instanceof MeshError) {
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
                    res.end('Internal Server Error');
                }
                this.broker.logger.debug(`Response: ${res.statusCode} ${res.statusMessage}`);
            }
        });

        this.server.on('error', (err) => {
            this.broker?.logger.error('Api server error', err);
        });

        await new Promise<void>((resolve, reject) => {
            this.server?.listen(SERVER_PORT, SERVER_HOST, () => {
                this.broker?.logger.info(`Api server running at ${SERVER_HOST}:${SERVER_PORT}`);
                resolve();
            });
            this.server?.once('error', reject);
        });
    }

    public async onStop(): Promise<void> {
        if (this.server) {
            await new Promise((resolve) => this.server?.close(resolve));
        }
    }

    private async resolveHostname(req: http.IncomingMessage): Promise<string> {
        const host = req.headers.host;
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
        return this.broker.call('serve.expose.find', { query: { apiId } }, { meta: { tenant_id: tenantId } });
    }

    private async resolveTarget(hostname: string): Promise<Target> {
        const api = await this.resolveApi(hostname);
        return { host: api.apiHost, tenantId: api.tenantId, rows: await this.resolveExposeRows(api.id, api.tenantId) };
    }

    /**
     * Bearer token could be a user ticket or an api token -- there is no prefix marking which, so
     * both are tried. Absent or unrecognized means anonymous, not an error: whether that's good
     * enough is the gate step's job, not this one's. Only the account id is kept -- roles are never
     * trusted from a ticket's own payload (which could be long-lived and stale); the gate step
     * re-resolves them fresh from identity.role/identity.membership on every call.
     */
    private async resolveCaller(req: http.IncomingMessage): Promise<Caller | undefined> {
        const header = req.headers.authorization;
        if (header === undefined || !header.startsWith('Bearer ')) {
            return undefined;
        }
        const token = header.slice('Bearer '.length).trim();
        if (token === '') {
            return undefined;
        }

        const ticket = await this.broker.call('identity.ticket.validate', { token });
        if (ticket.valid && ticket.userId !== undefined) {
            return { userId: ticket.userId };
        }

        const apiToken = await this.broker.call('identity.apiToken.validate', { token });
        if (apiToken.valid && apiToken.userId !== undefined) {
            return { userId: apiToken.userId };
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

        for (const row of rows) {
            const contract = globalContractRegistry.get(row.contract);
            if (contract === undefined || !isPublicContract(contract)) continue;
            if (contract.rest.method !== method) continue;

            const params = matchPath(contract.rest.path, urlPath);
            if (params !== undefined) {
                return { row, contract, params };
            }
        }
        return undefined;
    }

    /**
     * role is a coarse, direct role check (identity.hasRole); permission calls identity.permits, a
     * finer check against the role's own permission patterns. Both resolve the caller's effective
     * roles fresh, combining global account roles with their membership role in this target's own
     * tenant -- account roles are king, so a membership role can never stand in for a global one.
     * Neither role nor permission set on the row means public. No caller at all is only a problem
     * once the row actually demands one.
     */
    private async checkGate(row: Expose, caller: Caller | undefined, tenantId: string): Promise<void> {
        if (row.role === undefined && row.permission === undefined) {
            return;
        }

        if (caller === undefined) {
            throw new MeshError({ message: 'Authentication required.', code: 'UNAUTHORIZED', status: 401 });
        }

        // identity.membership is scopedBy: 'userId', which resolveCallerScope special-cases from
        // meta.user.id -- hasRole/permits resolve that account's own membership internally via
        // ctx.call, which inherits whatever meta this entry call carries, so it has to be set here.
        const meta = { user: { id: caller.userId, tenant_id: tenantId } };

        if (row.role !== undefined) {
            const result = await this.broker.call('identity.hasRole', {
                userId: caller.userId,
                role: row.role,
                organizationId: tenantId,
            }, { meta });
            if (!result.granted) {
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

        const meta = { user: { id: caller.userId, tenant_id: targetTenantId } };
        const result = await this.broker.call('identity.hasRole', {
            userId: caller.userId,
            role: 'operator',
            organizationId: targetTenantId,
        }, { meta });
        return result.granted ? requested : targetTenantId;
    }

    private readBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            let data = '';
            req.on('data', (chunk: Buffer) => { data += chunk.toString('utf-8'); });
            req.on('end', () => resolve(data));
            req.on('error', reject);
        });
    }

    private async parseInput(req: http.IncomingMessage, params: Record<string, string>): Promise<Record<string, unknown>> {
        const method = (req.method ?? 'GET').toUpperCase();

        if (method === 'GET' || method === 'DELETE') {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const query: Record<string, unknown> = {};
            for (const [key, value] of url.searchParams) {
                query[key] = value;
            }
            return { ...query, ...params };
        }

        const raw = await this.readBody(req);
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

    private async handleDescribe(target: Target, res: http.ServerResponse): Promise<void> {
        const descriptor = buildDescriptor(target.host, target.rows);

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

        const route = this.findRoute(target.rows, req);
        if (route === undefined) {
            res.statusCode = 404;
            res.end('Not Found');
            return;
        }

        const caller = await this.resolveCaller(req);
        await this.checkGate(route.row, caller, target.tenantId);

        const input = await this.parseInput(req, route.params);

        // Tools like identity.whoami read ctx.meta.user.id, so an anonymous ctx.call is not the
        // same call a caller made. tenant_id defaults to the target's own owning tenant -- the only
        // exception is an operator explicitly naming a different one (resolveEffectiveTenantId).
        const effectiveTenantId = await this.resolveEffectiveTenantId(caller, target.tenantId, input);
        const meta = caller === undefined
            ? undefined
            : { user: { id: caller.userId, tenant_id: effectiveTenantId } };

        // route.row.contract is a domain.action key validated at runtime (findRoute already
        // confirmed globalContractRegistry has a matching public contract for it) -- the broker's
        // own generic can't know that statically, so this crosses the boundary the same way mesh's
        // own generated CLI does for identical dynamic dispatch.
        const result = await this.broker.call(route.row.contract as keyof IServiceToolRegistry, input as never, { meta });

        const descriptor = buildDescriptor(target.host, target.rows);
        res.setHeader('x-exposure-shape', descriptor.shapeHash);
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(JSON.stringify(result));
    }
}
