import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream';
import crypto from 'node:crypto';

import { MeshError } from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';

import { type Site } from './contracts/site.contract.js';
import { artifactAssetPath } from '../catalog/methods/artifacts.js';
import type { Release } from '../catalog/contracts/release.contract.js';
import type { GetAssetOutput } from '../catalog/contracts/artifact.contract.js';

/** One servable file, with the digest a <script>/<link integrity=...> attribute checks against. */
interface WebAsset {
    url: string;
    integrity?: string;
}

/** One application/extension part, as the boot module will construct and register it with the
 * kernel -- `id` becomes both `PartRef.id` (for the kernel's own boot summary) and, for an
 * Application, the value `site.open[].application` has to match. */
interface BootPart {
    id: string;
    url: string;
    /** Becomes `PartRef.options` -- the site's decision, never the part's. Must already be
     *  JSON-serializable (validated at the schema layer, `catalog/schema/part.ts`): it is baked
     *  into the generated boot module as a literal, not handed a live object at runtime. */
    options?: Record<string, unknown>;
}

interface WebAssetRequest {
    kernel?: WebAsset;
    theme?: WebAsset;
    css: WebAsset[];
    parts: BootPart[];
    /** specifier -> asset URL, e.g. "@flybyme/mesh-core/ui" -> "<hash>/index.js". Built from every
     * release part that declared serve.part.imports, kernel included -- everything else that bundles
     * one of these bare specifiers left it external rather than inlining a second copy. This is
     * separate from `parts`: importMap is for *named* imports between modules (identity importing
     * `AUTH`), `parts` is for the boot module's own default-import-and-construct of each running
     * contribution. The same artifact can appear in both -- ui and auth are each importable by
     * specifier *and* have to be constructed and handed to `start()`. */
    importMap: Record<string, string>;
}

/** What resolveWebRequest actually hands back once it has confirmed a kernel exists -- kernel is
 * required here so a caller never has to re-check what was already validated. */
type ResolvedWebAssetRequest = WebAssetRequest & { kernel: WebAsset };

/**
 * Read live, not captured as a module-level const: `mesh-serve start`'s `--publicScheme`/
 * `--publicApiPort` flags set these env vars from inside `StartCommand.execute()`, which runs
 * *after* this module's own top-level code already ran (imports resolve, and therefore every
 * module-level `const`, before any command's `execute()` does) -- a const here would permanently
 * capture whatever was set before the process even started, the same way `API_PORT` would if
 * ApiService read it as one instead of inside `createServer()`. No scheme/protocol concept exists
 * anywhere else in mesh-serve yet; host/mcpHost are stored bare.
 */
export const publicScheme = (): string => process.env.PUBLIC_SCHEME || 'https';

export const apiOrigin = (host: string): string => {
    const port = process.env.PUBLIC_API_PORT;
    return `${publicScheme()}://${host}${port ? `:${port}` : ''}`;
};

/** Determine client IP address from an incoming HTTP request (forwarded-first, then socket remote). */
const getClientIp = (req: http.IncomingMessage): string => {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
        return forwarded.split(',')[0]?.trim() ?? '';
    }
    if (Array.isArray(forwarded)) {
        return forwarded[0]?.trim() ?? '';
    }
    return req.socket.remoteAddress ?? '';
};

export const escapeHtml = (str: string): string => str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

/**
 * Escapes an inline <script>'s JSON body so it can never contain `</script>` (none of this is
 * attacker-controlled -- release-pinned artifact hashes and this site's own stored record --
 * but the escape is free) and returns the CSP hash source that allowlists it. A hash, not
 * `'unsafe-inline'`, so an attacker-injected <script> elsewhere on the page still gets refused.
 */
export const inlineScript = (body: string): { escaped: string; hash: string } => {
    const escaped = body.replace(/</g, '\\u003c');
    return { escaped, hash: `sha256-${crypto.createHash('sha256').update(escaped).digest('base64')}` };
};

/** Content-Security-Policy for the HTML document: every asset URL is deterministic and
 * same-origin by the time this runs, and the only inline <script>s are the import map and the
 * boot module, each allowlisted by its own content hash rather than 'unsafe-inline' -- so
 * script-src stays strict against anything else. style-src allows 'unsafe-inline' for the
 * one inline <style> block (theme CSS vars); low severity, not worth an external per-request
 * stylesheet to avoid it.
 *
 * `scriptHashes` arrives pre-quoted (`"'sha256-...' 'sha256-...'"`) -- a CSP source list needs
 * the quotes around each hash itself, not just around the directive value as a whole; without
 * them the browser reports "contains an invalid source" and drops it silently rather than erring
 * loudly at the header. Found live, the first time this path actually rendered two hashes. */
export const contentSecurityPolicy = (
    site: Pick<Site, 'mcpHost'>,
    apiHost: string | undefined,
    scriptHashes: string,
): string => {
    const api = apiHost === undefined ? undefined : apiOrigin(apiHost);
    const mcp = `${publicScheme()}://${site.mcpHost}`;
    const wsScheme = publicScheme() === 'https' ? 'wss' : 'ws';
    const mcpWs = `${wsScheme}://${site.mcpHost}`;
    return [
        "default-src 'self'",
        `script-src 'self' ${scriptHashes}`,
        "style-src 'self' 'unsafe-inline'",
        `connect-src 'self' ${[api, mcp, mcpWs].filter((v) => v !== undefined).join(' ')}`,
        "img-src 'self' data: https:",
        "font-src 'self'",
    ].join('; ');
};

/** siteSchema.maintenance's own description says what this is: "redirect all traffic to
 * /.well-known/maintenance" -- previously just a thrown 503 with no redirect and no page. */
export const maintenancePage = (site: Pick<Site, 'title' | 'application'>): string => {
    const title = escapeHtml(site.title || site.application);
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title} -- under maintenance</title></head>`
        + `<body><h1>${title}</h1><p>This site is temporarily down for maintenance. Please check back shortly.</p></body></html>`;
};

/**
 * The frontend HTTP gateway: one cohesive thing with real private state (an `http.Server` and a
 * release-keyed request cache), which is why it stays a class. Dropping `ServiceModule` was never
 * about banning classes -- it was about removing the *tool-grouping* one, the bag that made
 * several unrelated contracts share a lifecycle. This holds no contracts at all. It is constructed
 * by `serve.cdn.listen`'s handler, and stopped by that contract's `ctx.signal`.
 */
export class CdnGateway {
    private server?: http.Server;

    /** Keyed by release hash -- immutable and content-addressed, so a cached entry can never go
     * stale. Unbounded for now; revisit with an eviction policy if it ever matters. */
    private webRequestCache = new Map<string, ResolvedWebAssetRequest>();

    private streamAsset: boolean = true;

    constructor(private readonly broker: IServiceBroker) {}

    /** Binds and resolves once listening -- the returned address is what the contract reports. */
    public async start(port?: number, host?: string): Promise<string> {

        const SERVER_PORT = port ?? parseInt(process.env.SERVER_PORT || '3123', 10);
        const SERVER_HOST = host ?? (process.env.SERVER_HOST || '::');

        this.server = http.createServer(async (req, res) => {
            const startedAt = Date.now();
            try {
                this.broker.logger.debug(`${req.method} ${req.url} ${JSON.stringify(req.headers)}`);
                await this.handleRequest(req, res);
            } catch (err) {
                if (err instanceof MeshError) {
                    res.statusCode = err.status;
                    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                    res.end(err.message);
                } else {
                    this.broker?.logger.error('Error handling request', err);
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                    res.end('Internal Server Error');
                }

                this.broker.logger.debug(`Response: ${res.statusCode} ${res.statusMessage} ${Date.now() - startedAt}ms`);
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

        return `${SERVER_HOST}:${SERVER_PORT}`;
    }

    /** Called from `serve.cdn.listen`'s abort handler -- nothing else stops this. */
    public async stop(): Promise<void> {
        if (this.server) {
            this.server.closeIdleConnections?.();
            await new Promise((resolve) => this.server?.close(resolve));
            this.server = undefined;
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
        const hostWithoutPort = host.startsWith('[')
            ? host.replace(/]:\d+$/, ']').replace(/^\[|\]$/g, '')
            : host.replace(/:\d+$/, '');
        const hostname = hostWithoutPort.toLowerCase().replace(/\.$/, '');
        if (hostname.length === 0) {
            throw new MeshError({
                code: 'Bad Request',
                message: 'No hostname',
                status: 400,
            });
        }
        return hostname;
    }

    /** Maintenance is handled in handleRequest (a redirect, not a thrown error) -- this only
     * resolves the hostname to a site. */
    private async resolveSite(hostname: string): Promise<Site> {

        const site = await this.broker.call('serve.cdn.resolveHost', { host: hostname });
        if (site === undefined) {
            throw new MeshError({
                code: 'Not Found',
                message: 'Site not found',
                status: 404,
            });
        }

        return site;
    }

    /**
     * A release is immutable and content-addressed (its own hash), so the shape this resolves to
     * can never change once computed -- cached by release.hash rather than re-walking every part's
     * artifact on every single page load. No `kind: 'driver'` branch: buildKernel bakes drivers
     * into the kernel's own single JS bundle, so compose.ts never emits a separate driver entry in
     * release.parts -- there is nothing to resolve here for them.
     */
    private async resolveWebRequest(release: Release): Promise<ResolvedWebAssetRequest> {
        // hash is optional only on serve.release.create's input (the before-hook mints it when
        // absent) -- a release actually reaching here was already stored, so it always has one.
        if (release.hash === undefined) {
            throw new MeshError({ message: `Release "${release.id}" has no hash.`, code: 'INTERNAL', status: 500 });
        }
        const hash = release.hash;

        const cached = this.webRequestCache.get(hash);
        if (cached !== undefined) {
            return cached;
        }

        const webRequest: WebAssetRequest = {
            kernel: undefined,
            theme: undefined,
            css: [],
            parts: [],
            importMap: {},
        }

        // release.artifacts embeds the full, already-built serve.artifact row -- no per-item fetch
        // needed for those. kind/imports/key live on the serve.part instead (not copied onto the
        // release, see schema/release.ts), so that's the one lookup still needed here, per artifact.
        const parts = await Promise.all(
            release.artifacts.map((artifact) => this.broker.call('serve.part.resolve', { id: artifact.partId }, { meta: { tenant_id: release.tenantId } })),
        );

        for (let i = 0; i < release.artifacts.length; i++) {
            const artifact = release.artifacts[i]!;
            const part = parts[i]!;
            if (part === undefined) {
                throw new MeshError({ message: `No part "${artifact.partId}" for artifact "${artifact.id}".`, code: 'INTERNAL', status: 500 });
            }
            const artifactHash = artifact.hash as string;
            const jsEntry = (artifact.assets ?? []).find((asset) => asset.fileExtension === '.js');
            if (part.imports !== undefined && jsEntry !== undefined) {
                webRequest.importMap[part.imports] = `${artifactHash}/${jsEntry.url}`;

                // `@flybyme/mesh-web`'s own entry re-exports everything `@flybyme/mesh-web/net`
                // does (call, defineApi, createClient, fetchTransport, withHeaders, MeshCallError
                // -- confirmed directly in a real built bundle's own `export{...}` statement), so
                // that subpath's code is already inside this same artifact. Every mesh-serve
                // generated client imports from `@flybyme/mesh-web/net` specifically (see
                // src/api/methods/generateClient.ts), never bare `@flybyme/mesh-web` -- without
                // this, any site whose build includes a generated client 404s in the browser with
                // "Failed to resolve module specifier" the instant that file's own top-level
                // import runs, since only the bare specifier was ever in the import map.
                if (part.imports === '@flybyme/mesh-web') {
                    webRequest.importMap['@flybyme/mesh-web/net'] = `${artifactHash}/${jsEntry.url}`;
                }
            }

            if (part.kind === 'kernel') {
                if (jsEntry) {
                    webRequest.kernel = { url: `${artifactHash}/${jsEntry.url}`, integrity: jsEntry.integrity };
                }
                // mesh-web's own entry does `import './kernel.css'`, so esbuild emits a real
                // entry.css alongside entry.js -- this `continue` skipped straight past the CSS
                // collection loop below and dropped it, every time, for every release. Found live:
                // the page rendered (the boot-module fix held) but with no kernel styling at all.
                const cssEntry = (artifact.assets ?? []).find((asset) => asset.fileExtension === '.css');
                if (cssEntry) {
                    webRequest.css.push({ url: `${artifactHash}/${cssEntry.url}`, integrity: cssEntry.integrity });
                }
                continue;
            }

            if (part.kind === 'theme') {
                const entry = (artifact.assets ?? []).find((asset) => asset.fileExtension === '.css');
                if (entry) {
                    webRequest.theme = { url: `${artifactHash}/${entry.url}`, integrity: entry.integrity };
                }
                continue;
            }

            for (const asset of artifact.assets ?? []) {
                if (asset.fileExtension === '.css') {
                    webRequest.css.push({ url: `${artifactHash}/${asset.url}`, integrity: asset.integrity });
                }
            }
            // Every application/extension part is a boot.js entry -- start() constructs each one's
            // default export and hands the running instance to the kernel; nothing runs on the page
            // from a part's module merely being fetched. A flat <script type="module"> per part
            // (this file's previous approach) loaded and evaluated each one but never called start(),
            // so nothing was ever constructed or registered -- a blank page with a fully downloaded,
            // fully silent set of scripts. Found live: no console error, because there wasn't one --
            // the page had genuinely finished doing everything it was told to do.
            if (jsEntry !== undefined) {
                webRequest.parts.push({
                    id: part.key,
                    url: `${artifactHash}/${jsEntry.url}`,
                    ...(part.options !== undefined ? { options: part.options } : {}),
                });
            }
        }

        const { kernel } = webRequest;
        if (kernel === undefined) {
            throw new MeshError({
                code: 'Not Found',
                message: 'Release has no kernel',
                status: 404,
            });
        }

        const resolved: ResolvedWebAssetRequest = { ...webRequest, kernel };
        this.webRequestCache.set(hash, resolved);
        return resolved;
    }

    /** `site.apiId` is optional -- a UI-only site calls no exposed contracts of its own. */
    private async resolveApiHost(site: Site): Promise<string | undefined> {
        if (site.apiId === undefined) return undefined;
        const api = await this.broker.call('serve.api.resolveById', { id: site.apiId });
        return api.apiHost;
    }

    private async generateHtml(
        site: Site, apiHost: string | undefined,
    ): Promise<{ html: string; scriptHashes: string }> {
        const html: string[] = [];

        if (!site.releaseHash) {
            throw new MeshError({
                code: 'Not Found',
                message: 'Site not deployed',
                status: 404,
            });
        }

        const release = await this.broker.call('serve.release.getRelease', { hash: site.releaseHash });

        const webRequest = await this.resolveWebRequest(release);

        const themeVars = Object.entries(site.theme)
            .map(([name, value]) => `${name}: ${value};`)
            .join(' ');

        const integrityAttr = (asset: WebAsset): string => asset.integrity ? ` integrity="${asset.integrity}"` : '';
        const styleTag = (asset: WebAsset): string => `<link rel="stylesheet" href="/assets/${asset.url}"${integrityAttr(asset)}>`;

        /**
         * Escapes an inline <script>'s JSON body so it can never contain `</script>` (none of this is
         * attacker-controlled -- release-pinned artifact hashes and this site's own stored record --
         * but the escape is free) and returns the CSP hash source that allowlists it. A hash, not
         * `'unsafe-inline'`, so an attacker-injected <script> elsewhere on the page still gets refused.
         */
        // Must appear before any <script type="module"> on the page -- browsers refuse to resolve an
        // import against a map registered after the first module has already started fetching.
        const importMapBody = Object.keys(webRequest.importMap).length === 0 ? undefined : JSON.stringify({
            imports: Object.fromEntries(Object.entries(webRequest.importMap).map(([specifier, url]) => [specifier, `/assets/${url}`])),
        });
        const importMap = importMapBody === undefined ? undefined : inlineScript(importMapBody);

        /**
         * `start()` (`mesh-web/kernel/start.ts`) is the kernel's real entry point: it takes an
         * explicit `{ application, policy, open, parts }` object, constructing each part's default
         * export itself and registering the running instance -- nothing on the page does anything
         * from a part's module merely being *fetched*. This file used to put `data-application`/
         * `data-policy`/`data-open` on the kernel's own <script> tag and load every other part as its
         * own flat <script type="module">; `start()` never reads a script tag's dataset (the one
         * exception, `data-api` on <html>, is a fallback for when `composition.api` isn't passed, so
         * passing it directly here makes that fallback moot) and a part's module loading is not the
         * same thing as the kernel constructing and booting it. The result was a fully downloaded,
         * fully silent page: no error, because every script had genuinely finished doing everything
         * it was told to do -- which was nothing. Found live, on a real page, after the import
         * resolution bug above was already fixed.
         */
        const bootLines = [`import { start } from '@flybyme/mesh-web';`];
        webRequest.parts.forEach((part, i) => bootLines.push(`import part_${String(i)} from '/assets/${part.url}';`));
        bootLines.push('start({');
        bootLines.push(`  application: ${JSON.stringify(site.application)},`);
        if (apiHost !== undefined) bootLines.push(`  api: ${JSON.stringify(apiOrigin(apiHost))},`);
        bootLines.push(`  policy: ${JSON.stringify(site.policy)},`);
        if (site.open !== undefined) bootLines.push(`  open: ${JSON.stringify(site.open)},`);
        bootLines.push(`  parts: [${webRequest.parts.map((part, i) => `{ id: ${JSON.stringify(part.id)}, contribution: part_${String(i)}${part.options !== undefined ? `, options: ${JSON.stringify(part.options)}` : ''} }`).join(', ')}],`);
        bootLines.push('});');
        const boot = inlineScript(bootLines.join('\n'));

        html.push(`<!DOCTYPE html>`);
        html.push(`<html>`);
        html.push(`
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${escapeHtml(site.title || site.application)}</title>
      ${site.description ? `<meta name="description" content="${escapeHtml(site.description)}">` : ''}
      ${site.canonical ? `<link rel="canonical" href="${escapeHtml(site.canonical)}">` : ''}
      ${site.image ? `<meta property="og:image" content="${escapeHtml(site.image)}">` : ''}
      ${site.indexable ? '' : '<meta name="robots" content="noindex, nofollow">'}
      ${apiHost ? `<link rel="preconnect" href="${apiOrigin(apiHost)}">` : ''}
      <link rel="preconnect" href="${publicScheme()}://${site.mcpHost}">
      ${themeVars ? `<style>:root { ${themeVars} }</style>` : ''}
      ${webRequest.theme ? styleTag(webRequest.theme) : ''}
      ${webRequest.css.map(styleTag).join('')}
      ${importMap ? `<script type="importmap">${importMap.escaped}</script>` : ''}
    </head>
    <body>
      <script type="module">${boot.escaped}</script>
    </body>
  </html>
`);

        return {
            html: html.join(''),
            scriptHashes: [importMap?.hash, boot.hash].filter((h): h is string => h !== undefined).map((h) => `'${h}'`).join(' '),
        };
    }

    private async serveAssets(site: Site, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {

        if (req.url === undefined) {
            throw new MeshError({
                code: 'Bad Request',
                message: 'No URL',
                status: 400,
            });
        }

        // req.url is "/assets/<artifactHash>/<path...>" -- strip query string before parsing segments
        const pathname = req.url.split('?')[0] ?? '';
        const [, , artifactHash, ...rest] = pathname.split('/');
        const assetPath = rest.join('/');
        if (artifactHash === undefined || assetPath === '') {
            throw new MeshError({
                code: 'Bad Request',
                message: 'No artifact hash or asset path',
                status: 400,
            });
        }

        const asset = await this.broker.call('serve.artifact.getAsset', { artifactHash, path: assetPath });
        const assetFilePath = artifactAssetPath(artifactHash, asset.path);

        if (this.streamAsset) {
            await this.handleAssetStreamRequest(req, res, asset, assetFilePath);
        } else {
            await this.handleAssetReadRequest(req, res, asset, assetFilePath);
        }
    }

    private async handleAssetStreamRequest(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        asset: GetAssetOutput,
        assetFilePath: string,
    ): Promise<void> {
        res.setHeader('Content-Type', asset.contentType);
        res.setHeader('Content-Length', asset.contentLength);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

        // Conditional validation (ETag & Last-Modified) BEFORE opening any file streams
        if (asset.eTag) {
            res.setHeader('ETag', asset.eTag);
            const ifNoneMatch = req.headers['if-none-match'];
            if (ifNoneMatch) {
                const clientTags = ifNoneMatch.split(',').map((t) => t.trim().replace(/^W\//, ''));
                const cleanEtag = asset.eTag.replace(/^W\//, '');
                if (clientTags.includes(cleanEtag) || clientTags.includes('*')) {
                    res.statusCode = 304;
                    res.end();
                    return;
                }
            }
        }

        if (asset.lastModified) {
            res.setHeader('Last-Modified', asset.lastModified);
            if (!req.headers['if-none-match']) {
                const ifModifiedSince = req.headers['if-modified-since'];
                if (ifModifiedSince) {
                    const clientTime = Date.parse(ifModifiedSince);
                    const assetTime = Date.parse(asset.lastModified);
                    if (!isNaN(clientTime) && !isNaN(assetTime) && clientTime >= assetTime) {
                        res.statusCode = 304;
                        res.end();
                        return;
                    }
                }
            }
        }

        // Handle HEAD requests: send headers without body stream
        if ((req.method ?? 'GET').toUpperCase() === 'HEAD') {
            res.statusCode = 200;
            res.end();
            return;
        }

        return new Promise((resolve) => {
            const fileStream = createReadStream(assetFilePath);

            pipeline(fileStream, res, (err) => {
                if (!err || err.code === 'ERR_STREAM_PREMATURE_CLOSE') {
                    resolve();
                    return;
                }

                this.broker?.logger.error(`Error streaming asset: ${assetFilePath}`, err);
                if (!res.headersSent) {
                    // Overrides the asset's own Content-Type already staged by setHeader earlier in
                    // this path (setHeader hasn't flushed yet, so headersSent is still false) --
                    // without this, an error body would go out mislabeled as e.g. application/javascript.
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                    res.end('Internal Server Error');
                }
                resolve();
            });
        });
    }

    private async handleAssetReadRequest(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        asset: GetAssetOutput,
        assetFilePath: string,
    ): Promise<void> {
        res.setHeader('Content-Type', asset.contentType);
        res.setHeader('Content-Length', asset.contentLength);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

        // Check conditional headers before reading the file into memory
        if (asset.eTag) {
            res.setHeader('ETag', asset.eTag);
            const ifNoneMatch = req.headers['if-none-match'];
            if (ifNoneMatch) {
                const clientTags = ifNoneMatch.split(',').map((t) => t.trim().replace(/^W\//, ''));
                const cleanEtag = asset.eTag.replace(/^W\//, '');
                if (clientTags.includes(cleanEtag) || clientTags.includes('*')) {
                    res.statusCode = 304;
                    res.end();
                    return;
                }
            }
        }

        if (asset.lastModified) {
            res.setHeader('Last-Modified', asset.lastModified);
            if (!req.headers['if-none-match']) {
                const ifModifiedSince = req.headers['if-modified-since'];
                if (ifModifiedSince) {
                    const clientTime = Date.parse(ifModifiedSince);
                    const assetTime = Date.parse(asset.lastModified);
                    if (!isNaN(clientTime) && !isNaN(assetTime) && clientTime >= assetTime) {
                        res.statusCode = 304;
                        res.end();
                        return;
                    }
                }
            }
        }

        if ((req.method ?? 'GET').toUpperCase() === 'HEAD') {
            res.statusCode = 200;
            res.end();
            return;
        }

        const fileContent = await fs.readFile(assetFilePath);
        res.end(fileContent);
    }


    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {

        const clientIp = getClientIp(req);

        // Check method is GET or HEAD.
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            throw new MeshError({
                code: 'Method Not Allowed',
                message: 'Method not allowed',
                status: 405,
            });
        }

        const hostname = await this.resolveHostname(req);

        const site = await this.resolveSite(hostname);

        const pathname = (req.url ?? '/').split('?')[0] ?? '/';

        if (pathname === '/.well-known/maintenance') {
            const page = maintenancePage(site);
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Content-Length', Buffer.byteLength(page));
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.statusCode = 200;
            res.end(page);
            return;
        }

        if (site.maintenance) {
            res.statusCode = 302;
            res.setHeader('Location', '/.well-known/maintenance');
            res.end();
            return;
        }

        if (site.releaseHash === undefined) {
            throw new MeshError({
                code: 'Not Found',
                message: 'Site not deployed',
                status: 404,
            });
        }

        // check if path is an asset.
        const assetPath = pathname.startsWith('/assets/');


        if (assetPath) {
            return this.serveAssets(site, req, res);
        }

        const apiHost = await this.resolveApiHost(site);
        const { html, scriptHashes } = await this.generateHtml(site, apiHost);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Length', Buffer.byteLength(html));
        res.setHeader('Content-Security-Policy', contentSecurityPolicy(site, apiHost, scriptHashes));
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        res.statusCode = 200;
        res.end(html);


    }
}

