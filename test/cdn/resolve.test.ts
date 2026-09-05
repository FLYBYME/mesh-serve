/**
 * A site's URL space.
 *
 * The two tests that matter here are both about things that fail *silently* in the design this
 * replaces: an artifact URL that a site never composed, and a cache header decided by looking at a
 * filename instead of at how the file was addressed.
 */

import { describe, expect, it } from 'vitest';

import type { Artifact, ArtifactFile } from '../../src/builder/schema/artifact.js';
import {
    headersFor, pathOf, resolveFile, resolveRequest, slugOf,
} from '../../src/cdn/methods/resolve.js';
import type { Resolution } from '../../src/cdn/schema/site.js';

const PAGE = 'sha256:page';
const KERNEL = 'sha256:kernel';
const CHROME = 'sha256:chrome';

const resolution: Resolution = {
    kernel: { version: '1.4.0', digest: KERNEL },
    parts: { chrome: { version: '1.0.0', digest: CHROME } },
    exposure: 'sha256:exposure',
    page: PAGE,
    resolvedAt: new Date(0),
};

const site = { resolution };

const file = (path: string, contentType = 'text/javascript; charset=utf-8'): ArtifactFile =>
    ({ path, digest: `sha256:${path}`, size: 1, contentType });

const artifact = (...paths: string[]): Artifact => ({
    digest: 'sha256:a',
    files: paths.map((p) => file(p)),
    totalSize: paths.length,
    builtAt: new Date(0),
    buildId: 'b1',
    declaration: {
        part: { kind: 'application', id: 'a', version: '1.0.0', entry: 'index.js' },
        requires: [],
        builtAgainst: [],
    },
});

describe('which artifact answers', () => {
    it('serves the generated page for an ordinary path', () => {
        expect(resolveRequest(site, '/')).toEqual({ digest: PAGE, path: '/', immutable: false });
        expect(resolveRequest(site, '/settings')?.digest).toBe(PAGE);
    });

    it('serves a composed artifact at its own hash', () => {
        expect(resolveRequest(site, `/_a/${slugOf(KERNEL)}/index.js`))
            .toEqual({ digest: KERNEL, path: '/index.js', immutable: true });
    });

    it('serves a part the same way', () => {
        expect(resolveRequest(site, `/_a/${slugOf(CHROME)}/index.js`)?.digest).toBe(CHROME);
    });

    it('treats a bare artifact prefix as that artifact\'s root', () => {
        expect(resolveRequest(site, `/_a/${slugOf(KERNEL)}`)?.path).toBe('/');
    });

    it('refuses an artifact this site did not compose', () => {
        // Without this, `/_a/<any digest>/` is an open proxy into every other tenant's code — served
        // from *this* site's origin, which is the boundary the whole isolation model rests on.
        expect(resolveRequest(site, '/_a/somebodyelses/index.js')).toBeUndefined();
    });

    it('has nothing to serve before a site has been composed', () => {
        expect(resolveRequest({ resolution: undefined }, '/')).toBeUndefined();
    });

    it('cannot be shadowed by a part, because parts have no names here', () => {
        // The predecessor mounted artifacts under chosen prefixes, so a mount at `/framework` could
        // silently capture `/frameworks-of-the-world.html` from a site that already served it.
        // There is one reserved prefix now, and a page keeps every other path it had.
        expect(resolveRequest(site, '/_artifacts-of-mine.html')?.digest).toBe(PAGE);
        expect(resolveRequest(site, '/framework/index.js')?.digest).toBe(PAGE);
    });
});

describe('which file answers', () => {
    it('takes an exact match', () => {
        expect(resolveFile(artifact('index.html', 'app.js'), '/app.js')?.path).toBe('app.js');
    });

    it('takes a directory index, with or without the trailing slash', () => {
        const a = artifact('about/index.html');
        expect(resolveFile(a, '/about')?.path).toBe('about/index.html');
        expect(resolveFile(a, '/about/')?.path).toBe('about/index.html');
    });

    it('falls back to the entry document, so a deep link reaches the app', () => {
        expect(resolveFile(artifact('index.html'), '/settings/theme')?.path).toBe('index.html');
    });

    it('404s a missing asset instead of serving HTML', () => {
        // Serving the page for a missing module produces `Unexpected token '<'` in a console and
        // nothing at all that says which file was missing.
        expect(resolveFile(artifact('index.html'), '/app.js')).toBeUndefined();
    });

    it('404s inside a part artifact, which has no entry document to fall back to', () => {
        expect(resolveFile(artifact('index.js'), '/missing')).toBeUndefined();
    });
});

describe('caching', () => {
    it('caches an artifact URL forever, because the URL is the content', () => {
        const resolved = resolveRequest(site, `/_a/${slugOf(KERNEL)}/index.js`)!;
        const headers = headersFor(file('index.js'), resolved);

        expect(headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });

    it('never caches the page, which is the only mutable name on the site', () => {
        const resolved = resolveRequest(site, '/')!;
        expect(headersFor(file('index.html', 'text/html'), resolved)['cache-control']).toBe('no-cache');
    });

    it('validates on the file\'s own digest', () => {
        const resolved = resolveRequest(site, '/')!;
        expect(headersFor(file('index.html'), resolved)['etag']).toBe('"sha256:index.html"');
    });

    it('varies on Host, because one connection may serve many sites', () => {
        const resolved = resolveRequest(site, '/')!;
        expect(headersFor(file('index.html'), resolved)['vary']).toBe('Host');
    });
});

describe('paths', () => {
    it('drops the query and decodes', () => {
        expect(pathOf('/a%20b?x=1')).toBe('/a b');
    });

    it('leaves a malformed encoding alone rather than throwing', () => {
        // It then simply fails to match a file, which is a 404 — not a 500 on every crawler.
        expect(pathOf('/%E0%A4%A')).toBe('/%E0%A4%A');
    });
});
