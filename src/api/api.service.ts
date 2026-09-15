import http from 'node:http';

import { Database, globalContractRegistry, isPublicContract, MeshError, ServiceModule } from '@flybyme/mesh';
import type { IServiceBroker, IServiceToolRegistry, ToolContract } from '@flybyme/mesh';

import { exposeCrud, exposeAddContract, exposeRemoveContract, type Expose } from './contracts/expose.contract.js';
import { wantCrud } from './contracts/want.contract.js';
import { generateClientContract } from './contracts/generateClient.contract.js';
import { buildDescriptor, API_BASE } from './methods/descriptor.js';
import { matchPath } from './methods/route.js';
import { add } from './tools/add.js';
import { remove } from './tools/remove.js';
import { generateClient } from './tools/generateClient.js';
import type { Site } from '../cdn/contracts/site.contract.js';

interface Caller {
    readonly userId: string;
}

interface Route {
    readonly row: Expose;
    readonly contract: ToolContract;
    readonly params: Record<string, string>;
}

/** What every request needs, whether it resolved to a real site or the always-on default host. */
interface Target {
    readonly host: string;
    readonly tenantId: string | undefined;
    readonly rows: readonly Expose[];
}

const DEFAULT_API_HOST = process.env.DEFAULT_API_HOST ?? 'api.localhost';

/**
 * Always exposed on DEFAULT_API_HOST, tied to no site and no tenant -- this is how a fresh install
 * gets anyone in at all, plus the two calls that let an operator start configuring real sites
 * without needing anything pre-seeded by hand. Kept otherwise minimal on purpose: register, log in,
 * ask who you are. Anything else goes through explicit expose rows once something needs it.
 *
 * `identity.user.setPassword` belongs here too, not behind a site-scoped expose row -- there is no
 * way to add one for the default host in the first place (`serve.expose.add` requires a `siteId`,
 * and a default-host row is exactly the row with none), which meant a fresh install's first-boot
 * account could log in, call whoami, and nothing else: the one call the boot message says it *can*
 * make -- "It can do nothing except set its own password" -- was unreachable. Confirmed live: a POST
 * to /expose for it 400s with "siteId: Required" no matter who calls it.
 */
const DEFAULT_EXPOSED_CONTRACTS: readonly { contract: string; role?: string }[] = [
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

        this.mountCrud(exposeCrud);
        this.mountCrud(wantCrud);
        this.mountTool(exposeAddContract, add);
        this.mountTool(exposeRemoveContract, remove);
        this.mountTool(generateClientContract, generateClient);
    }

    public async onStart(broker: IServiceBroker): Promise<void> {
        this.broker = broker;
        await this.seedDefaultExposure();
        await this.createServer();
    }

    /**
     * Checked every boot, idempotently -- these rows have no tenant to scope a generated-CRUD write
     * through, so this reads/writes serve.expose directly rather than via serve.expose.create.
     */
    private async seedDefaultExposure(): Promise<void> {
        const db = this.broker.getProvider<Database>('database');
        const repo = db.repo(exposeCrud.get.outputSchema, 'serve.expose');

        for (const { contract, role } of DEFAULT_EXPOSED_CONTRACTS) {
            const existing = await repo.findOne({ contract, siteId: { $exists: false } });
            if (existing === undefined) {
                this.broker.logger.info(`Exposing "${contract}"${role ? ` (role: ${role})` : ''} on the default host (${DEFAULT_API_HOST})...`);
                // Passing role: undefined explicitly (rather than omitting the key) stores it as
                // null, which the schema's z.string().optional() then rejects on the next read.
                await repo.create(role !== undefined ? { contract, role } : { contract });
            }
        }
    }

    private async createServer(): Promise<void> {
        const SERVER_PORT = parseInt(process.env.API_PORT || '5005', 10);
        const SERVER_HOST = process.env.SERVER_HOST || '::';

        this.server = http.createServer(async (req, res) => {
            try {
                this.broker.logger.debug(`${req.method} ${req.url} ${JSON.stringify(req.headers)}`);
                await this.handleRequest(req, res);
            } catch (err) {
                if (err instanceof MeshError) {
                    res.statusCode = err.status;
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

    private async resolveSite(hostname: string): Promise<Site> {
        const site = await this.broker.call('serve.cdn.resolveApiHost', { apiHost: hostname });
        if (site === undefined) {
            throw new MeshError({ code: 'Not Found', message: 'Site not found', status: 404 });
        }
        return site;
    }

    /**
     * This runs before any caller is known, but resolveCallerScope (DatabaseMiddleware.js) doesn't
     * actually need a caller -- it falls back to a bare meta.tenant_id when meta.user is absent. The
     * site we already resolved names its own tenant, so that's what scopes this read: no bypass, no
     * caller required, just the tenant context this request is already known to be serving.
     */
    private async resolveExposeRows(siteId: string, tenantId: string): Promise<Expose[]> {
        return this.broker.call('serve.expose.find', { query: { siteId } }, { meta: { tenant_id: tenantId } });
    }

    /** No tenant applies to the default host's rows at all, so this is a genuine cross-tenant read. */
    private async resolveDefaultExposeRows(): Promise<Expose[]> {
        const db = this.broker.getProvider<Database>('database');
        const repo = db.repo(exposeCrud.get.outputSchema, 'serve.expose');
        return repo.find({ query: { siteId: { $exists: false } } });
    }

    private async resolveTarget(hostname: string): Promise<Target> {
        if (hostname === DEFAULT_API_HOST) {
            return { host: DEFAULT_API_HOST, tenantId: undefined, rows: await this.resolveDefaultExposeRows() };
        }
        const site = await this.resolveSite(hostname);
        return { host: site.apiHost, tenantId: site.tenantId, rows: await this.resolveExposeRows(site.id, site.tenantId) };
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
     * tenant (absent on the default host, so only global roles ever apply there) -- account roles
     * are king, so a membership role can never stand in for a global one. Neither role nor permission
     * set on the row means public. No caller at all is only a problem once the row actually demands one.
     */
    private async checkGate(row: Expose, caller: Caller | undefined, tenantId: string | undefined): Promise<void> {
        if (row.role === undefined && row.permission === undefined) {
            return;
        }

        if (caller === undefined) {
            throw new MeshError({ message: 'Authentication required.', code: 'UNAUTHORIZED', status: 401 });
        }

        // identity.membership is scopedBy: 'userId', which resolveCallerScope special-cases from
        // meta.user.id -- hasRole/permits resolve that account's own membership internally via
        // ctx.call, which inherits whatever meta this entry call carries, so it has to be set here.
        // IMeshMeta.user.tenant_id is a required string; '' on the default host is an unused
        // placeholder -- organizationId is undefined there, so membership resolution never runs.
        const meta = { user: { id: caller.userId, tenant_id: tenantId ?? '' } };

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
        // same call a caller made. tenant_id is the target's own owning tenant; '' on the default
        // host is an unused placeholder, same reasoning as checkGate's meta above.
        const meta = caller === undefined
            ? undefined
            : { user: { id: caller.userId, tenant_id: target.tenantId ?? '' } };

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
