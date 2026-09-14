import http from 'node:http';

import { globalContractRegistry, isPublicContract, MeshError, ServiceModule } from '@flybyme/mesh';
import type { IServiceBroker, IServiceToolRegistry, ToolContract } from '@flybyme/mesh';

import { exposeCrud, type Expose } from './contracts/expose.contract.js';
import { wantCrud } from './contracts/want.contract.js';
import { buildDescriptor } from './methods/descriptor.js';
import { matchPath } from './methods/route.js';
import type { Site } from '../cdn/contracts/site.contract.js';

interface Caller {
    readonly userId: string;
}

interface Route {
    readonly row: Expose;
    readonly contract: ToolContract;
    readonly params: Record<string, string>;
}

export class ApiService extends ServiceModule {
    public readonly domain = 'serve.api';

    private server?: http.Server;
    private broker!: IServiceBroker;

    constructor() {
        super();

        this.mountCrud(exposeCrud);
        this.mountCrud(wantCrud);
    }

    public async onStart(broker: IServiceBroker): Promise<void> {
        this.broker = broker;
        await this.createServer();
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
     */
    private findRoute(rows: readonly Expose[], req: http.IncomingMessage): Route | undefined {
        const method = (req.method ?? 'GET').toUpperCase();
        const urlPath = (req.url ?? '/').split('?')[0] ?? '/';

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
     * roles fresh, combining global account roles with their membership role in this site's own
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

    private async handleDescribe(site: Site, rows: readonly Expose[], res: http.ServerResponse): Promise<void> {
        const descriptor = buildDescriptor(site.apiHost, rows);

        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(JSON.stringify(descriptor));
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const hostname = await this.resolveHostname(req);
        const site = await this.resolveSite(hostname);

        const rows = await this.resolveExposeRows(site.id, site.tenantId);

        const urlPath = (req.url ?? '/').split('?')[0];
        if (urlPath === '/api/_describe') {
            return this.handleDescribe(site, rows, res);
        }

        const route = this.findRoute(rows, req);
        if (route === undefined) {
            res.statusCode = 404;
            res.end('Not Found');
            return;
        }

        const caller = await this.resolveCaller(req);
        await this.checkGate(route.row, caller, site.tenantId);

        const input = await this.parseInput(req, route.params);

        // Tools like identity.whoami read ctx.meta.user.id, so an anonymous ctx.call is not the
        // same call a caller made. tenant_id is the site's own owning tenant -- this request is
        // being served within that site's org context.
        const meta = caller !== undefined
            ? { user: { id: caller.userId, tenant_id: site.tenantId } }
            : undefined;

        // route.row.contract is a domain.action key validated at runtime (findRoute already
        // confirmed globalContractRegistry has a matching public contract for it) -- the broker's
        // own generic can't know that statically, so this crosses the boundary the same way mesh's
        // own generated CLI does for identical dynamic dispatch.
        const result = await this.broker.call(route.row.contract as keyof IServiceToolRegistry, input as never, { meta });

        const descriptor = buildDescriptor(site.apiHost, rows);
        res.setHeader('x-exposure-shape', descriptor.shapeHash);
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(JSON.stringify(result));
    }
}
