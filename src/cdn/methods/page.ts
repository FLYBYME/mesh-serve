/**
 * The page the cdn generates for a composition.
 *
 * Nobody writes `index.html`. Nobody writes a boot file. Both used to be hand-written in every site
 * repository, and the console's `main.ts` is the evidence for why that could not continue: 140 lines
 * of framework wiring, plus **five undeclared contracts between a bundle and an HTML file** — a
 * `#console` element, a `#notifications` element, a stylesheet defining `.window` and `.titlebar`, an
 * import map, and `data-api`. Nothing declared them and nothing checked them, so getting one wrong
 * rendered a blank or half-styled page with no error naming the cause. It ended with
 * `export { page }` that nothing imported: the file already knew it should be handing the page to
 * something, and there was no something.
 *
 * ## The one rule this file follows
 *
 * **The cdn generates a composition, never framework code.**
 *
 * The composition is what the cdn actually knows: this hostname, this API, these parts at these
 * digests, these theme values. Everything the old boot file did *besides* that — constructing a
 * window manager, choosing settings hives, wiring a mesh client, mounting a page, rendering
 * notifications, handling resize — is framework behaviour, identical on every site, and generating
 * it here would mean the cdn had to be updated whenever the kernel changed. A code generator that
 * has to track another package's internals is a second copy of that package.
 *
 * So the kernel exposes **one entry point** that takes a composition, and the generated boot module
 * is a handful of imports and a single call. That entry point does not exist yet — see
 * `spec/serving.md` — and until it does, this generates a page against an API the kernel has not
 * grown. That is the honest order: the shape of the generated file is what says what the kernel owes.
 *
 * ## Generated per request, and not an artifact
 *
 * **Changed 2026-09-06.** It was going to be hashed and stored like everything else, on the argument
 * that the page should not be the one thing in the system that is not content-addressed. That was
 * wrong for a reason the site record made obvious: a page carries the site's `title`, `description`
 * and canonical URL, so **two hostnames on one release do not have the same page** — and content
 * addressing a per-site document means an artifact per site, which is the coupling releases exist to
 * remove.
 *
 * So the page is a *response*, built from site + release. It costs a string concatenation over data
 * the edge already holds, and it is cacheable in memory keyed on `(siteId, releaseHash)` — the same
 * key that makes invalidation correct by construction, since either changing makes the cached page
 * stale.
 *
 * What it buys is the thing that would otherwise have been lost: **SEO metadata reaches the
 * document**. A title injected by script after boot is a title a crawler never sees.
 */

import { ClientError } from '@flybyme/mesh';

import type { Site } from '../contracts/site.contract.js';
import type { Release } from '../contracts/release.contract.js';
import { slugOf } from './resolve.js';

/** A file the cdn produced, before it is hashed into an artifact. */
export interface GeneratedFile {
    readonly path: string;
    readonly content: string;
}

export interface PageInput {
    readonly site: Pick<Site,
        'application' | 'api' | 'theme' | 'policy'
        | 'title' | 'description' | 'canonical' | 'indexable'>;
    readonly release: Release;
    /**
     * What the kernel artifact contains, read from its own declaration and file list.
     *
     * Passed in rather than guessed: the cdn does not get to assume the kernel's entry is called
     * `index.js`, and a wrong guess here is a blank page whose only symptom is a 404 for a file
     * nobody named.
     */
    readonly kernel: {
        readonly entry: string;
        /** Every stylesheet the kernel ships. The rules; the site supplies the values. */
        readonly styles: readonly string[];
    };
    /**
     * Stylesheets shipped by each part, by part id.
     *
     * Like `kernel.styles`, read from each part artifact's file list.
     */
    readonly partStyles?: Readonly<Record<string, readonly string[]>>;
}

/** The URL an artifact's file is served at. See `resolve.ts` — an artifact's URL is its hash. */
const urlOf = (digest: string, path: string): string =>
    `/_a/${slugOf(digest)}/${path.replace(/^\/+/, '')}`;

/**
 * The page, the boot module, and nothing else.
 *
 * Deterministic: parts are emitted in id order, so two compositions that differ only in how someone
 * typed a list produce byte-identical output and therefore one artifact. Content addressing makes
 * that matter — non-determinism here would be a new digest on every deploy that changed nothing.
 */
export function generatePage(input: PageInput): readonly GeneratedFile[] {
    const { site, release, kernel, partStyles } = input;

    const kernelUrl = urlOf(release.kernel.digest, kernel.entry);
    const parts = Object.entries(release.parts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, artifact], index) => ({ id, index, url: urlOf(artifact.digest, 'index.js') }));

    return [
        { path: 'index.html', content: indexHtml(site, kernel, kernelUrl, release, partStyles) },
        { path: 'boot.js', content: bootModule(site, kernelUrl, parts) },
    ];
}

// ---------------------------------------------------------------------------- the shell

function indexHtml(
    site: PageInput['site'],
    kernel: PageInput['kernel'],
    kernelUrl: string,
    release: Release,
    partStyles?: PageInput['partStyles'],
): string {
    /**
     * Why an import map, and why it is not optional.
     *
     * A part is built with the framework `external`, so its code contains a bare
     * `import … from '@flybyme/mesh-web'` that a browser cannot resolve on its own. This is what
     * resolves it — **to exactly one URL**. Two URLs would be two module graphs and two of every
     * singleton the capability model depends on, which is the failure that inlining the framework
     * into each part produced and that no amount of testing one part at a time would reveal.
     */
    const importMap = JSON.stringify({ imports: { '@flybyme/mesh-web': kernelUrl } }, null, 4);

    const kernelLinks = kernel.styles
        .map((path) => `    <link rel="stylesheet" href="${attr(urlOf(release.kernel.digest, path))}">`);

    const partLinks: string[] = [];
    if (partStyles !== undefined) {
        const sortedParts = Object.entries(release.parts)
            .sort(([a], [b]) => a.localeCompare(b));
        for (const [id, artifact] of sortedParts) {
            const files = partStyles[id] ?? [];
            const sortedFiles = [...files].sort((a, b) => a.localeCompare(b));
            for (const path of sortedFiles) {
                partLinks.push(`    <link rel="stylesheet" href="${attr(urlOf(artifact.digest, path))}">`);
            }
        }
    }

    const styles = [...kernelLinks, ...partLinks].join('\n');

    return `<!doctype html>
<html lang="en" data-api="${attr(site.api)}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
${metadata(site)}
    <script type="importmap">
${indent(importMap, 4)}
    </script>

${styles}
    <style>
        :root {
${themeTokens(site.theme)}
        }
    </style>
</head>
<body>
    <script type="module" src="boot.js"></script>
</body>
</html>
`;
}

/**
 * What a crawler reads.
 *
 * **In the document, which is the entire reason the page is generated per request.** A title set by
 * script after boot is a title a crawler that does not run JavaScript never sees — and this is a
 * window manager, so what a part renders is invisible to one anyway. Site-level metadata reaching
 * the markup is what makes the difference between a site that can be indexed and one that cannot.
 *
 * `title` falls back to `application`, which is a grouping label rather than a name — better than an
 * empty `<title>`, and worse than one somebody wrote, which is why it is a fallback.
 *
 * `noindex` matters more than it looks: a staging site and production may sit on **one release**,
 * identical in every way except this record, and without it they compete for the same search
 * results.
 */
function metadata(site: PageInput['site']): string {
    const title = site.title === '' ? site.application : site.title;

    const lines = [
        `    <title>${text(title)}</title>`,
        `    <meta property="og:title" content="${attr(title)}">`,
    ];

    if (site.description !== '') {
        lines.push(`    <meta name="description" content="${attr(site.description)}">`);
        lines.push(`    <meta property="og:description" content="${attr(site.description)}">`);
    }
    if (site.canonical !== undefined) {
        lines.push(`    <link rel="canonical" href="${attr(site.canonical)}">`);
    }
    if (!site.indexable) {
        lines.push('    <meta name="robots" content="noindex, nofollow">');
    }

    return lines.join('\n');
}

/**
 * The theme, as custom properties on `:root`.
 *
 * **The kernel owns the rules and the site owns the values.** `.window { background: var(--surface) }`
 * ships with the kernel, once; what `--surface` is is decided here. That is what lets two instances
 * of one application sit side by side under different themes with a single stylesheet between them —
 * custom properties inherit, so setting them again on a window host retheme everything inside it,
 * with no shadow DOM, no build-time scoping and nothing to collide.
 *
 * Values are checked rather than trusted. A site record is written by its owner, who is not
 * necessarily the operator of this cdn, and this output is the platform's own page: a value
 * containing `}` would close the rule and let a site write arbitrary CSS into a document it does not
 * own. Refused loudly, because silently dropping a token is a theme that is subtly wrong with
 * nothing to point at.
 */
function themeTokens(theme: Readonly<Record<string, string>>): string {
    return Object.entries(theme)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => {
            if (!/^--[a-z0-9][a-z0-9-]*$/i.test(name)) {
                throw new PageError(`Theme token "${name}" is not a custom property name.`);
            }
            if (/[<>{};]/.test(value)) {
                throw new PageError(
                    `Theme token "${name}" has a value that would escape its declaration: "${value}".`,
                );
            }
            return `            ${name}: ${value};`;
        })
        .join('\n');
}

// ---------------------------------------------------------------------------- the boot module

/**
 * Imports, and one call.
 *
 * **The order of `parts` here is not the order they start.** The kernel resolves that from what each
 * part `provides` and `consumes` — an application consuming `AUTH` starts after the extension that
 * provides it, and nothing in this file says so. Emitting them in id order is therefore safe *and*
 * is what keeps the output deterministic.
 */
function bootModule(
    site: PageInput['site'],
    kernelUrl: string,
    parts: readonly { readonly id: string; readonly index: number; readonly url: string }[],
): string {
    const imports = parts
        .map((part) => `import part${String(part.index)} from '${js(part.url)}';`)
        .join('\n');

    const entries = parts
        .map((part) => `        { id: '${js(part.id)}', contribution: part${String(part.index)} },`)
        .join('\n');

    return `// Generated by the cdn for this composition. Do not edit: it is rewritten whenever the
// site's parts, theme or policy change, and it is addressed by the hash of its own bytes.
import { start } from '${js(kernelUrl)}';
${imports}

start({
    application: '${js(site.application)}',
    // The one value a page cannot discover at run time. Read from the document rather than written
    // in here, so the same boot module works behind a proxy that rewrote the origin.
    api: document.documentElement.dataset.api ?? '',
    policy: ${indent(JSON.stringify(site.policy, null, 4), 4).trimStart()},
    parts: [
${entries}
    ],
});
`;
}

// ---------------------------------------------------------------------------- escaping

/**
 * A site record that cannot be turned into a page.
 *
 * `422`: the record parsed, and it still describes a page that must not be generated. A caller can
 * act on this one — it names the token — so unlike `TenantMismatch` the message is the point.
 */
export class PageError extends ClientError {
    constructor(message: string) {
        super(message, 'page_invalid', 422);
    }
}

/** Text in an element. */
const text = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Text in a double-quoted attribute. */
const attr = (value: string): string => text(value).replace(/"/g, '&quot;');

/**
 * Text in a single-quoted JavaScript string, in a module served as its own file.
 *
 * A separate file rather than an inline `<script>`, which removes the `</script>` escape entirely —
 * the one HTML escaping rule that does not work the way it looks like it should.
 */
const js = (value: string): string => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '');

const indent = (block: string, spaces: number): string =>
    block.split('\n').map((line) => `${' '.repeat(spaces)}${line}`).join('\n');
