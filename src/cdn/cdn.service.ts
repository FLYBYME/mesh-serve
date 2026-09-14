import http from 'node:http';
import fs from 'node:fs/promises';

import { MeshError, ServiceModule } from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';

import {
    siteCrud,
    siteResolveHostContract,
    siteResolveApiHostContract,
    type Site
} from './contracts/site.contract.js';

import { resolveHost } from './tools/resolveHost.js';
import { resolveApiHost } from './tools/resolveApiHost.js';
import { artifactAssetPath } from '../catalog/methods/artifacts.js';
import type { Release } from '../catalog/contracts/release.contract.js';

interface WebAssetRequest {
    kernel?: string;
    drivers: string[];
    theme?: string;
    css: string[];
    js: string[];
}

export class CdnService extends ServiceModule {
    public readonly domain = 'serve.cdn';

    private server?: http.Server;
    private broker!: IServiceBroker;

    constructor() {
        super();

        this.mountCrud(siteCrud);
        this.mountTool(siteResolveHostContract, resolveHost);
        this.mountTool(siteResolveApiHostContract, resolveApiHost);
    }


    public async onStart(broker: IServiceBroker): Promise<void> {
        this.broker = broker;
        await this.createServer();
    }


    private async createServer() {

        const SERVER_PORT = parseInt(process.env.SERVER_PORT || '3123', 10);
        const SERVER_HOST = process.env.SERVER_HOST || '::';

        this.server = http.createServer(async (req, res) => {
            try {
                this.broker.logger.debug(`${req.method} ${req.url} ${JSON.stringify(req.headers)}`);
                await this.handleRequest(req, res);
            } catch (err) {
                if (err instanceof MeshError) {
                    res.statusCode = err.status;
                    res.end(err.message);
                } else {
                    this.broker?.logger.error('Error handling request', err);
                    res.statusCode = 500;
                    res.end('Internal Server Error');
                }

                this.broker.logger.debug(`Response: ${res.statusCode} ${res.statusMessage}`);
            }
        });

        this.server.on('error', (err) => {
            this.broker?.logger.error('Server error', err);
        });

        await new Promise<void>((resolve, reject) => {
            this.server?.listen(SERVER_PORT, SERVER_HOST, () => {
                this.broker?.logger.info(`Server running at ${SERVER_HOST}:${SERVER_PORT}`);
                resolve();
            });
            this.server?.once('error', reject);
        });
    }

    public async onStop(broker: IServiceBroker): Promise<void> {
        await this.stopServer()
    }

    private async stopServer() {
        if (this.server) {
            await new Promise((resolve) => this.server?.close(resolve));
        }
    }

    private async resolveHostname(req: http.IncomingMessage): Promise<string> {
        const host = req.headers.host;
        if (host === undefined) {
            throw new MeshError({
                code: 'Bad Request',
                message: 'No host header',
                status: 400,
            });
        }
        const [hostname] = host.split(':');
        if (hostname === undefined) {
            throw new MeshError({
                code: 'Bad Request',
                message: 'No hostname',
                status: 400,
            });
        }
        return hostname;
    }

    private async resolveSite(hostname: string): Promise<Site> {

        const site = await this.broker.call('serve.cdn.resolveHost', { host: hostname });
        if (site === undefined) {
            throw new MeshError({
                code: 'Not Found',
                message: 'Site not found',
                status: 404,
            });
        }

        if (site.maintenance) {
            throw new MeshError({
                code: 'Service Unavailable',
                message: 'Site under maintenance',
                status: 503,
            });
        }

        return site;
    }

    private parseCookies(req: http.IncomingMessage): Record<string, string> {
        const header = req.headers.cookie;
        if (header === undefined) {
            return {};
        }
        const cookies: Record<string, string> = {};
        for (const part of header.split(';')) {
            const idx = part.indexOf('=');
            if (idx === -1) continue;
            const key = part.slice(0, idx).trim();
            const value = part.slice(idx + 1).trim();
            if (key.length > 0) {
                cookies[key] = decodeURIComponent(value);
            }
        }
        return cookies;
    }

    /**
     * A session cookie is only ever read here, to decide what to bake into the initial HTML. It is
     * never sent by mesh-web's own runtime API calls (those are bearer-only, deliberately, to avoid
     * the CSRF surface a cookie creates for a state-changing request) -- this is a different request
     * (a plain document navigation) serving a different purpose (skip a login round-trip on return).
     */
    private async resolveTicket(req: http.IncomingMessage): Promise<string | undefined> {
        const cookies = this.parseCookies(req);
        const token = cookies['mesh_ticket'];
        if (token === undefined) {
            return undefined;
        }
        const result = await this.broker.call('identity.ticket.validate', { token });
        return result.valid ? token : undefined;
    }

    private async resolveWebRequest(release: Release, req: http.IncomingMessage): Promise<WebAssetRequest> {
        const webRequest: WebAssetRequest = {
            kernel: undefined,
            drivers: [],
            theme: undefined,
            css: [],
            js: []
        }

        for (const part of release.parts) {

            const artifact = await this.broker.call('serve.artifact.getArtifact', { hash: part.artifactHash });

            if (part.kind === 'kernel') {
                const entry = (artifact.assets ?? []).find((asset) => asset.fileExtension === '.js');
                if (entry) {
                    webRequest.kernel = `${part.artifactHash}/${entry.url}`;
                }
                continue;
            }

            if (part.kind === 'driver') {
                const entry = (artifact.assets ?? []).find((asset) => asset.fileExtension === '.js');
                if (entry) {
                    webRequest.drivers.push(`${part.artifactHash}/${entry.url}`);
                }
                continue;
            }

            if (part.kind === 'theme') {
                const entry = (artifact.assets ?? []).find((asset) => asset.fileExtension === '.css');
                if (entry) {
                    webRequest.theme = `${part.artifactHash}/${entry.url}`;
                }
                continue;
            }

            for (const asset of artifact.assets ?? []) {
                if (asset.fileExtension === '.css') {
                    webRequest.css.push(`${part.artifactHash}/${asset.url}`);
                }
                if (asset.fileExtension === '.js') {
                    webRequest.js.push(`${part.artifactHash}/${asset.url}`);
                }
            }
        }

        if (webRequest.kernel === undefined) {
            throw new MeshError({
                code: 'Not Found',
                message: 'Release has no kernel',
                status: 404,
            });
        }

        return webRequest;
    }

    private async generateHtml(site: Site, req: http.IncomingMessage): Promise<string> {
        const html: string[] = [];

        if (!site.releaseHash) {
            throw new MeshError({
                code: 'Not Found',
                message: 'Site not deployed',
                status: 404,
            });
        }

        const release = await this.broker.call('serve.release.getRelease', { hash: site.releaseHash });

        const ticket = await this.resolveTicket(req);

        const webRequest = await this.resolveWebRequest(release, req);

        const themeVars = Object.entries(site.theme)
            .map(([name, value]) => `${name}: ${value};`)
            .join(' ');

        html.push(`<!DOCTYPE html>`);
        html.push(`<html>`);
        html.push(`
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${site.title}</title>
      ${site.description ? `<meta name="description" content="${site.description}">` : ''}
      ${themeVars ? `<style>:root { ${themeVars} }</style>` : ''}
      ${webRequest.theme ? `<link rel="stylesheet" href="/assets/${webRequest.theme}">` : ''}
      ${webRequest.css.map((style) => `<link rel="stylesheet" href="/assets/${style}">`).join('')}
    </head>
    <body>
      <script
        type="module"
        src="/assets/${webRequest.kernel}"
        data-application="${site.application}"
        data-api="${site.apiHost}"
        data-mcp="${site.mcpHost}"
        data-policy='${JSON.stringify(site.policy)}'
        ${site.open ? `data-open='${JSON.stringify(site.open)}'` : ''}
        ${ticket !== undefined ? `data-ticket="${ticket}"` : ''}
      ></script>
      ${webRequest.js.map((script) => `<script type="module" src="/assets/${script}"></script>`).join('')}
    </body>
  </html>
`);

        return html.join('')
    }

    private async serveAssets(site: Site, req: http.IncomingMessage, res: http.ServerResponse) {

        if (req.url === undefined) {
            throw new MeshError({
                code: 'Bad Request',
                message: 'No URL',
                status: 400,
            });
        }

        // req.url is "/assets/<artifactHash>/<path...>"
        const [, , artifactHash, ...rest] = req.url.split('/');
        const assetPath = rest.join('/');
        if (artifactHash === undefined || assetPath === '') {
            throw new MeshError({
                code: 'Bad Request',
                message: 'No artifact hash or asset path',
                status: 400,
            });
        }

        const asset = await this.broker.call('serve.artifact.getAsset', { artifactHash, path: assetPath });

        const fileContent = await fs.readFile(artifactAssetPath(artifactHash, asset.path));
        res.setHeader('Content-Type', asset.contentType);
        res.setHeader('Content-Length', asset.contentLength);
        if (asset.eTag) {
            res.setHeader('ETag', asset.eTag);
            const ifNoneMatch = req.headers['if-none-match'];
            if (ifNoneMatch === asset.eTag) {
                res.statusCode = 304;
                res.end();
                return;
            }
        }

        if (asset.lastModified) {
            res.setHeader('Last-Modified', asset.lastModified);
            const ifModifiedSince = req.headers['if-modified-since'];
            if (ifModifiedSince === asset.lastModified) {
                res.statusCode = 304;
                res.end();
                return;
            }
        }

        // set cache control header for 1 year.
        res.setHeader('Cache-Control', 'public, max-age=31536000');

        // set content disposition header.
        res.setHeader('Content-Disposition', `attachment; filename="${asset.name}"`);

        // set content length header.
        res.setHeader('Content-Length', asset.contentLength);

        // set content encoding header if the asset is compressed.
        if (asset.fileExtension === '.gz') {
            res.setHeader('Content-Encoding', 'gzip');
        }

        // send file.
        res.end(fileContent);
    }


    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {

        const hostname = await this.resolveHostname(req);

        const site = await this.resolveSite(hostname);


        if (site.releaseHash === undefined) {
            throw new MeshError({
                code: 'Not Found',
                message: 'Site not deployed',
                status: 404,
            });
        }

        // check if path is an asset.
        const assetPath = req.url?.startsWith('/assets/');


        if (assetPath) {
            return this.serveAssets(site, req, res);
        }

        const html = await this.generateHtml(site, req);
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Content-Length', Buffer.byteLength(html));
        res.statusCode = 200;
        res.end(html);


    }
}
