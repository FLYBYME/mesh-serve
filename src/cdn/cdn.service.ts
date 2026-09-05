/**
 * The `cdn` ServiceModule — **the thing that binds a port.**
 *
 * It answers two very different callers, and they do not look alike:
 *
 * - **the world**, over HTTP, asking for a hostname and a path. Once this node's caches are warm
 *   that path touches no mesh call at all, which is what lets a node be small and many.
 * - **the cluster**, over the mesh: compose a release, deploy one, and the events that say a site
 *   changed.
 *
 * ## What it holds between requests, and why none of it is state
 *
 * A site cache, a release cache, artifact manifests, and generated pages. Every one is derivable and
 * discardable, so no node is different from any other and a cold node is *slower*, never wrong.
 *
 * The pages are cached on `(siteId, releaseHash)` — the key that makes invalidation correct by
 * construction, because either changing makes the cached page stale by definition.
 */

import { ServiceModule, type IServiceBroker } from '@flybyme/mesh';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { BlobStore } from '../builder/blobs.js';
import { fileBlobStore } from '../builder/blobs.js';
import type { Artifact } from '../builder/schema/artifact.js';
import {
    composeContract, deployContract, releaseCrud, type Release,
} from './contracts/release.contract.js';
import { resolveSiteContract, siteCrud, type Site } from './contracts/site.contract.js';
import { SiteSchema } from './schema/site.js';
import { assertTenant, hostOf, TenantMismatch } from './methods/hostname.js';
import { generatePage } from './methods/page.js';
import { headersFor, pathOf, resolveFile, resolveRequest } from './methods/resolve.js';
import { cdn_compose } from './tools/compose.js';
import { cdn_deploy } from './tools/deploy.js';
import { cdn_resolve_site } from './tools/resolve_site.js';

/** Only what `resolve_site` needs: one query, bounded. Deliberately not the whole repository. */
export interface SiteRepo {
    find(options: { query: Record<string, unknown>; limit: number }): Promise<readonly unknown[]>;
}

export interface CdnServiceOptions {
    /** `0` picks one, which is what a test wants. */
    readonly port?: number;
    readonly host?: string;
    /** Which tenant this node may serve, if it is dedicated to one. */
    readonly tenantId?: string;
    /** Where artifact bytes are cached on this node's disk. */
    readonly blobRoot?: string;
    readonly blobs?: BlobStore;
    /**
     * Take the hostname from `x-forwarded-host`.
     *
     * **Off by default, and it has to be a decision.** Behind the surfdns proxy the header is
     * authoritative, because the proxy rewrote `Host` to reach this node. A node reachable *directly*
     * must not trust it: a caller could then name any hostname and be served whatever it serves. That
     * is public content either way, so it is not a disclosure — but it makes the origin a caller's
     * choice, and the origin is the isolation boundary.
     */
    readonly trustForwardedHost?: boolean;
    /** How long a cached site or release may be stale. The backstop, not the mechanism. */
    readonly cacheTtlMs?: number;
}

export const DEFAULT_TTL_MS = 30_000;

export class CdnService extends ServiceModule {
    public readonly domain = 'cdn';

    public blobs!: BlobStore;
    /** The bound server, so a test can address it without guessing a port. */
    public listener: Server | undefined;
    public port: number | undefined;

    private broker: IServiceBroker | undefined;
    private database: { repo(schema: unknown, domain: string): SiteRepo } | undefined;
    private readonly ttl: number;

    /**
     * Every cache on this node, and each one keyed by the thing that invalidates it.
     *
     * Artifacts and pages need no TTL: an artifact is addressed by content and can never come to
     * mean something else, and a page is keyed on `(siteId, releaseHash)` so a deploy changes the
     * key rather than staling the value. Only `sites` needs one, because a hostname's record is
     * mutable and this node may miss the event that says so — the mesh delivers at-most-once, which
     * is what makes the TTL real work rather than tidying up.
     */
    private readonly sites = new Map<string, { site: Site | undefined; expires: number }>();
    private readonly releases = new Map<string, Release>();
    private readonly artifacts = new Map<string, Artifact>();
    private readonly pages = new Map<string, readonly { path: string; content: string }[]>();

    constructor(private readonly options: CdnServiceOptions = {}) {
        super();
        this.ttl = options.cacheTtlMs ?? DEFAULT_TTL_MS;

        this.mountCrud(siteCrud);
        this.mountCrud(releaseCrud);

        this.mountTool(composeContract, cdn_compose);
        this.mountTool(deployContract, cdn_deploy);
        this.mountTool(resolveSiteContract, cdn_resolve_site);

        // Every node drops the hostname it was told about, including the one that published it —
        // which costs a single lookup and means there is no "was it me?" branch to get wrong.
        this.mountEventHandler('cdn.site_deployed', (payload) => {
            this.sites.delete(payload.host);
        });
    }

    async onStart(broker: IServiceBroker): Promise<void> {
        this.broker = broker;
        this.database = broker.getProvider('database');
        const root = this.options.blobRoot ?? process.env['MESH_BLOB_ROOT'] ?? './.artifacts';
        this.blobs = this.options.blobs ?? fileBlobStore({ root });

        // Thrown from onStart when the port is taken, so the mesh sees a module that failed to start
        // rather than a node registered as a cdn that answers nothing.
        this.listener = await this.listen(this.options.port ?? 0, this.options.host ?? '0.0.0.0');
        const address = this.listener.address();
        this.port = typeof address === 'object' && address !== null ? address.port : this.options.port;

        broker.logger.info(`[cdn] serving on ${String(this.port)}, artifacts in ${root}`);
    }

    async onStop(): Promise<void> {
        const open = this.listener;
        this.listener = undefined;
        if (open === undefined) return;
        await new Promise<void>((done) => { open.close(() => { done(); }); });
    }

    /**
     * The site collection, read directly — see `tools/resolve_site.ts` for why, and for the
     * invariant that makes it defensible. Nothing else in this service may use it.
     */
    siteRepo(): SiteRepo {
        if (this.database === undefined) throw new Error('The cdn is not started.');
        return this.database.repo(SiteSchema, 'site');
    }

    private listen(port: number, host: string): Promise<Server> {
        const server = createServer((req, res) => { void this.handle(req, res); });
        return new Promise((resolve, reject) => {
            server.listen(port, host, () => { resolve(server); });
            server.once('error', reject);
        });
    }

    // ------------------------------------------------------------------ serving

    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const host = hostOf(req.headers, this.options.trustForwardedHost ?? false);
        const path = pathOf(req.url ?? '/');

        try {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                // A cdn serves. Anything that changes state goes to the API, which is the only
                // security boundary — a cdn accepting a POST would be a second one.
                return send(res, 405, { allow: 'GET, HEAD' }, 'Method not allowed');
            }

            const site = await this.siteFor(host);
            if (site === undefined) return send(res, 404, {}, 'No site is configured for this hostname.');

            // Checked on the path that serves rather than assumed by the path that configures: the
            // origin is the isolation boundary and this is where an origin is decided.
            assertTenant(host, site, this.options.tenantId);

            if (site.releaseHash === undefined) {
                return send(res, 503, {}, 'This site has not been deployed yet.');
            }

            const release = await this.releaseFor(site.releaseHash);
            if (release === undefined) {
                return send(res, 503, {}, 'That release is not available from this node yet.');
            }

            const resolved = resolveRequest(release, path);
            // The request named an artifact this release does not contain. A 404 rather than a 403:
            // which artifacts exist is not something an anonymous request gets to probe for.
            if (resolved === undefined) return send(res, 404, {}, 'Not found');

            const answer = resolved.kind === 'page'
                ? await this.pageFile(site, release, path)
                : await this.artifactFile(resolved.digest, resolved.path);

            if (answer === undefined) return send(res, 404, {}, 'Not found');

            // The digest is the whole validator: a matching `If-None-Match` means the client holds
            // this exact content, because a different byte would be a different digest.
            const headers = headersFor(answer.file, resolved);
            if (req.headers['if-none-match'] === headers['etag']) {
                return send(res, 304, { etag: headers['etag']!, vary: 'Host' }, '');
            }

            send(res, 200, headers, req.method === 'HEAD' ? '' : answer.body);
        } catch (error) {
            if (error instanceof TenantMismatch) {
                // Refused, and deliberately not explained: which tenant owns a hostname is not
                // something an anonymous request gets to learn.
                this.broker?.logger.warn(`[cdn] ${error.message}`);
                return send(res, 404, {}, 'Not found');
            }

            this.broker?.logger.error(`[cdn] ${host}${path}`, error);
            send(res, 500, {}, 'Internal error');
        }
    }

    /** The generated page, built from site + release and cached on both. */
    private async pageFile(
        site: Site,
        release: Release,
        path: string,
    ): Promise<{ file: { path: string; digest: string; size: number; contentType: string }; body: Buffer } | undefined> {
        const key = `${site.id}:${release.hash}`;
        let files = this.pages.get(key);

        if (files === undefined) {
            const kernel = await this.artifactFor(release.kernel.digest);
            if (kernel === undefined) return undefined;

            files = generatePage({
                site,
                release,
                kernel: {
                    entry: kernel.declaration.part.entry,
                    styles: kernel.files.filter((f) => f.path.endsWith('.css')).map((f) => f.path),
                },
            });
            this.pages.set(key, files);
        }

        const name = path === '/' || path === '' ? 'index.html' : path.replace(/^\/+/, '');
        // A client-routed deep link gets the page, exactly as it would inside an artifact. An asset
        // request does not: serving HTML for a missing module produces `Unexpected token '<'` and
        // nothing that says which file was missing.
        const wanted = files.find((f) => f.path === name)
            ?? (/\.[a-z0-9]+$/i.test(name) ? undefined : files.find((f) => f.path === 'index.html'));
        if (wanted === undefined) return undefined;

        const body = Buffer.from(wanted.content, 'utf8');
        return {
            file: {
                path: wanted.path,
                // Over the bytes, so an unchanged page revalidates even though it was never stored.
                digest: `sha256:${createDigest(body)}`,
                size: body.length,
                contentType: wanted.path.endsWith('.html')
                    ? 'text/html; charset=utf-8'
                    : 'text/javascript; charset=utf-8',
            },
            body,
        };
    }

    private async artifactFile(
        digest: string,
        path: string,
    ): Promise<{ file: { path: string; digest: string; size: number; contentType: string }; body: Buffer } | undefined> {
        const artifact = await this.artifactFor(digest);
        if (artifact === undefined) return undefined;

        const file = resolveFile(artifact, path);
        if (file === undefined) return undefined;

        const body = await this.blobFor(file.digest);
        return body === undefined ? undefined : { file, body };
    }

    // ------------------------------------------------------------------ lookups

    private async siteFor(host: string): Promise<Site | undefined> {
        const held = this.sites.get(host);
        if (held !== undefined && held.expires > Date.now()) return held.site;

        // Its own contract rather than the collection, for the reason that contract exists: `site`
        // has to become scope-restricted, and this call carries no caller because a browser is
        // anonymous. Serving and managing are two operations, so they get two doors.
        const found = await this.call<Site | null>('cdn.resolve_site', { host })
            .catch(() => null);
        const site = found ?? undefined;

        // A miss is cached too. A node asked repeatedly for a hostname nobody configured is
        // otherwise a database lookup per request, which is a cheap way to make a cdn do the
        // cluster's work for whoever is asking.
        this.sites.set(host, { site, expires: Date.now() + this.ttl });
        return site;
    }

    private async releaseFor(hash: string): Promise<Release | undefined> {
        const held = this.releases.get(hash);
        if (held !== undefined) return held;

        const found = await this.call<Release | null>('release.find_one', { query: { hash } });
        // Cached without a TTL, and safely: a release hash is derived from its contents, so a hash
        // can never come to mean a different composition.
        if (found !== null && found !== undefined) this.releases.set(hash, found);
        return found ?? undefined;
    }

    private async artifactFor(digest: string): Promise<Artifact | undefined> {
        const held = this.artifacts.get(digest);
        if (held !== undefined) return held;

        // Through the builder's contract, never into its collection: the day the builder changes how
        // it stores artifacts, this must not break.
        const found = await this.call<Artifact | undefined>('builder.get_artifact', { digest })
            .catch(() => undefined);
        if (found !== undefined) this.artifacts.set(digest, found);
        return found;
    }

    /**
     * The bytes, from this node's disk or from whoever has them.
     *
     * A fetch is one hop per file per node, paid once, because content addressed by hash is
     * cacheable forever. The remote half is **not built** — see roadmap C5 — so today a node that
     * does not hold a file cannot serve it, which is honest and is why a single node is M1.
     */
    private async blobFor(digest: string): Promise<Buffer | undefined> {
        return this.blobs.get(digest);
    }

    private async call<T>(tool: string, params: unknown): Promise<T> {
        if (this.broker === undefined) throw new Error('The cdn is not started.');
        return await (this.broker as unknown as {
            call(tool: string, params: unknown): Promise<T>;
        }).call(tool, params);
    }
}

/**
 * A validator for a page that is never stored.
 *
 * The page is generated per request, so it has no artifact digest to be validated by — but it is
 * byte-stable for a given `(site, release)`, so hashing the bytes gives a real ETag and an unchanged
 * page still answers 304.
 */
const createDigest = (content: Buffer): string =>
    createHash('sha256').update(content).digest('hex').slice(0, 32);

function send(
    res: ServerResponse,
    status: number,
    headers: Readonly<Record<string, string>>,
    body: string | Buffer,
): void {
    res.writeHead(status, {
        // A cache between here and a browser must key on the hostname it was asked for: the proxy in
        // front may serve many sites down one connection.
        vary: 'Host',
        ...headers,
    });
    res.end(body === '' ? undefined : body);
}

export default CdnService;
