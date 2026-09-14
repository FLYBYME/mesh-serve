import http from 'node:http';

import { MeshError, ServiceModule } from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';

import { exposeCrud } from './contracts/expose.contract.js';
import { wantCrud } from './contracts/want.contract.js';
import { buildDescriptor } from './methods/descriptor.js';
import type { Site } from '../cdn/contracts/site.contract.js';

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

    private async handleDescribe(site: Site, res: http.ServerResponse): Promise<void> {
        const rows = await this.broker.call('serve.expose.find', { query: { siteId: site.id } });
        const descriptor = buildDescriptor(site.apiHost, rows);

        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(JSON.stringify(descriptor));
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const hostname = await this.resolveHostname(req);
        const site = await this.resolveSite(hostname);

        if (req.url === '/api/_describe') {
            return this.handleDescribe(site, res);
        }

        res.statusCode = 404;
        res.end('Not Found');
    }
}
