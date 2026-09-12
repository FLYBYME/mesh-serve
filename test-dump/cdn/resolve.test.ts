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

const KERNEL = 'sha256:kernel';
const CHROME = 'sha256:chrome';

/** What a release contributes to serving. There is no page digest: the page is not an artifact. */
const release = {
    kernel: { digest: KERNEL },
    parts: { chrome: { digest: CHROME } },
};

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
        requiredParts: [],
        builtAgainst: [],
    },
    state: 'available',
});

describe('which artifact answers', () => {
    it('answers an ordinary path with the generated page', () => {
        // Not an artifact and not a digest: the page is generated per request from site + release,
        // so site-level title and meta reach the document rather than being set by a script after a
        // crawler has already read it.
        expect(resolveRequest(release, '/')).toEqual({ kind: 'page' });
        expect(resolveRequest(release, '/settings')).toEqual({ kind: 'page' });
    });

    it('serves a released artifact at its own hash', () => {
        expect(resolveRequest(release, `/_a/${slugOf(KERNEL)}/index.js`))
            .toEqual({ kind: 'artifact', digest: KERNEL, path: '/index.js' });
    });

    it('serves a part the same way', () => {
        const answer = resolveRequest(release, `/_a/${slugOf(CHROME)}/index.js`);
        expect(answer).toMatchObject({ kind: 'artifact', digest: CHROME });
    });

    it('treats a bare artifact prefix as that artifact\'s root', () => {
        expect(resolveRequest(release, `/_a/${slugOf(KERNEL)}`))
            .toMatchObject({ kind: 'artifact', path: '/' });
    });

    it('refuses an artifact this release does not contain', () => {
        // Without this, `/_a/<any digest>/` is an open proxy into every other tenant's code — served
        // from *this* site's origin, which is the boundary the whole isolation model rests on.
        expect(resolveRequest(release, '/_a/somebodyelses/index.js')).toBeUndefined();
    });

    it('has nothing to serve before a site has a release', () => {
        // A hostname reserved before its first deploy. Ordinary, not an error.
        expect(resolveRequest(undefined, '/')).toBeUndefined();
    });

    it('cannot be shadowed by a part, because parts have no names here', () => {
        // The predecessor mounted artifacts under chosen prefixes, so a mount at `/framework` could
        // silently capture `/frameworks-of-the-world.html` from a site that already served it.
        // There is one reserved prefix now, and a page keeps every other path it had.
        expect(resolveRequest(release, '/_artifacts-of-mine.html')).toEqual({ kind: 'page' });
        expect(resolveRequest(release, '/framework/index.js')).toEqual({ kind: 'page' });
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
        const resolved = resolveRequest(release, `/_a/${slugOf(KERNEL)}/index.js`)!;
        const headers = headersFor(file('index.js'), resolved);

        expect(headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });

    it('never caches the page, which is the only mutable name on the site', () => {
        const resolved = resolveRequest(release, '/')!;
        expect(headersFor(file('index.html', 'text/html'), resolved)['cache-control']).toBe('no-cache');
    });

    it('validates on the file\'s own digest', () => {
        const resolved = resolveRequest(release, '/')!;
        expect(headersFor(file('index.html'), resolved)['etag']).toBe('"sha256:index.html"');
    });

    it('varies on Host, because one connection may serve many sites', () => {
        const resolved = resolveRequest(release, '/')!;
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
