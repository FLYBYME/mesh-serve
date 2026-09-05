/**
 * A site's URL space: which artifact answers a path, and which file inside it.
 *
 * ## Every artifact is served at its own hash
 *
 * A site is composed of several artifacts — a kernel, some parts, and the page the cdn generated for
 * this composition. The predecessor gave each one a *name*: a mount at `/framework`, longest prefix
 * wins, matching on a segment boundary so that `/framework` could not steal
 * `/frameworks-of-the-world.html`. That worked, and the bug it had to defend against is the reason
 * to stop naming them at all.
 *
 * **An artifact is bytes and a hash, so its URL is its hash.** One rule, three consequences:
 *
 * - **Nothing can be shadowed.** `/_a/` is one reserved prefix rather than an open-ended set of
 *   mounts, so adding a part to a site cannot silently capture a path the site already served.
 * - **Everything under it is immutable**, so it is `cache-control: immutable` without a judgement
 *   call. Only the generated page is `no-cache`, and it is the only mutable name on the site.
 * - **Redeploying a part changes its URL**, so a browser holding the old one is not holding a stale
 *   copy of the new one — it is holding a different module that nothing points at any more.
 *
 * The cost is unreadable URLs in a network tab. That is a real cost, paid once by whoever is
 * debugging, against a class of collision that would be paid by whoever deployed.
 *
 * ## A site may only serve what it composed
 *
 * The digest in the URL is a *claim*, and it is checked against the site's own resolution. Without
 * that check `/_a/<any digest>/` would serve any artifact in the store from this origin, which is an
 * open proxy into every other tenant's code — and it would do it from *their* code inside *this*
 * site's origin, which is precisely the boundary `assertTenant` exists to hold.
 */

import type { Artifact, ArtifactFile } from '../../builder/schema/artifact.js';
import type { Site } from '../contracts/site.contract.js';
import type { Resolution } from '../schema/site.js';

/** The one reserved prefix in a site's URL space. */
export const ARTIFACT_PREFIX = '/_a/';

/**
 * The path, without a query string and percent-decoded.
 *
 * Never a filesystem path — a malformed encoding is left as-is so it simply fails to match a file
 * rather than throwing.
 */
export function pathOf(url: string): string {
    const [raw] = url.split('?');
    try {
        return decodeURIComponent(raw ?? '/');
    } catch {
        return raw ?? '/';
    }
}

/** A digest with its algorithm prefix removed — what appears in a URL. */
export const slugOf = (digest: string): string => {
    const colon = digest.indexOf(':');
    return colon === -1 ? digest : digest.slice(colon + 1);
};

/**
 * Every artifact digest this site composed, by URL slug.
 *
 * The page is in here too, so `/_a/<page>/index.html` is reachable as well as `/index.html`. That
 * costs nothing and means one rule covers the whole site: a request either names an artifact or gets
 * the page.
 */
export function composedArtifacts(resolution: Resolution): ReadonlyMap<string, string> {
    const digests = [
        resolution.page,
        resolution.kernel.digest,
        ...Object.values(resolution.parts).map((part) => part.digest),
    ];
    return new Map(digests.map((digest) => [slugOf(digest), digest]));
}

export interface Resolved {
    /** Which artifact answers. */
    readonly digest: string;
    /** The path *within* that artifact. */
    readonly path: string;
    /**
     * Whether the URL names the content it serves.
     *
     * Only the page is reached by a mutable name, so only the page must not be cached. This is the
     * whole of the caching policy, and it is a property of *how it was addressed* rather than of the
     * file — which is why it is decided here and not by looking at a filename.
     */
    readonly immutable: boolean;
}

/**
 * Which artifact answers this path.
 *
 * `undefined` means the request named an artifact this site did not compose. That is a 404 rather
 * than a 403: which artifacts exist is not something an anonymous request gets to probe for.
 */
export function resolveRequest(
    site: Pick<Site, 'resolution'>,
    path: string,
): Resolved | undefined {
    const resolution = site.resolution;
    // A site that has never been composed has nothing to serve. Distinguished from "no such site" by
    // the caller, because the two need different answers: this one is the cluster owing an answer.
    if (resolution === undefined) return undefined;

    if (!path.startsWith(ARTIFACT_PREFIX)) {
        return { digest: resolution.page, path, immutable: false };
    }

    const rest = path.slice(ARTIFACT_PREFIX.length);
    const slash = rest.indexOf('/');
    const slug = slash === -1 ? rest : rest.slice(0, slash);

    const digest = composedArtifacts(resolution).get(slug);
    if (digest === undefined) return undefined;

    const inner = slash === -1 ? '/' : rest.slice(slash);
    return { digest, path: inner === '' ? '/' : inner, immutable: true };
}

/**
 * Which file in an artifact answers a path.
 *
 * Three rules, in order, and the third is what makes a client-routed Application work:
 *
 * 1. an exact match
 * 2. a directory index — `/about` and `/about/` both mean `about/index.html`
 * 3. **the entry document**, for anything else, so a deep link into a client-routed app is served
 *    the app rather than a 404
 *
 * Rule 3 does not apply to anything that looks like an asset. A missing `app.js` must 404: serving
 * HTML in its place produces `Unexpected token '<'` in a console and nothing that says what
 * happened. It also means rule 3 is inert for a part artifact, which has no `index.html` at all —
 * so a missing module under `/_a/` fails honestly without needing a rule of its own.
 */
export function resolveFile(artifact: Artifact, path: string): ArtifactFile | undefined {
    const clean = path.replace(/^\/+/, '');
    const byPath = new Map(artifact.files.map((file) => [file.path, file]));

    const exact = byPath.get(clean);
    if (exact !== undefined) return exact;

    const index = byPath.get(clean === '' ? 'index.html' : `${clean.replace(/\/+$/, '')}/index.html`);
    if (index !== undefined) return index;

    if (/\.[a-z0-9]+$/i.test(clean)) return undefined;

    return byPath.get('index.html');
}

/**
 * What to send with a file.
 *
 * `etag` is the file's digest and nothing else: a matching `If-None-Match` means the client holds
 * this exact content, because a different byte would be a different digest.
 */
export function headersFor(file: ArtifactFile, resolved: Resolved): Readonly<Record<string, string>> {
    return {
        'content-type': file.contentType,
        etag: `"${file.digest}"`,
        'cache-control': resolved.immutable
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        // A cache between here and a browser must key on the hostname it was asked for: the proxy in
        // front may serve many sites down one connection.
        vary: 'Host',
    };
}
