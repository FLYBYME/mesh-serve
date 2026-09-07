/**
 * The generated page.
 *
 * One assertion here is worth more than the rest put together: **the framework resolves to exactly
 * one URL.** Two URLs are two module graphs and two of every singleton, and nothing about testing a
 * single part would ever reveal it.
 */

import { describe, expect, it } from 'vitest';

import { generatePage, PageError, type PageInput } from '../../src/cdn/methods/page.js';

const input = (over: Partial<PageInput> = {}): PageInput => ({
    site: {
        application: 'surfdns-console',
        api: 'https://console.surfdns.net/api',
        theme: { '--surface': '#161b22', '--ink': '#e6edf3' },
        policy: { 'window-manager/mode': 'tiled' },
        title: '',
        description: '',
        indexable: true,
    },
    release: {
        id: 'r1',
        hash: 'sha256:release',
        name: '',
        tenantId: 'org-1',
        kernel: { version: '1.4.0', digest: 'sha256:kernel' },
        parts: {
            chrome: { version: '1.0.0', digest: 'sha256:chrome' },
            'process-monitor': { version: '2.0.0', digest: 'sha256:monitor' },
        },
        requires: [],
        policy: {},
        composedAt: new Date(0),
        createdAt: new Date(0),
        updatedAt: new Date(0),
    },
    kernel: { entry: 'index.js', styles: ['kernel.css'] },
    ...over,
});

const fileOf = (files: readonly { path: string; content: string }[], path: string): string =>
    files.find((f) => f.path === path)?.content ?? '';

describe('what it emits', () => {
    it('is a page and a boot module, and nothing else', () => {
        expect(generatePage(input()).map((f) => f.path)).toEqual(['index.html', 'boot.js']);
    });

    it('is byte-identical for the same composition', () => {
        // It is hashed like any other artifact, so non-determinism would mean a new digest on every
        // deploy that changed nothing.
        expect(generatePage(input())).toEqual(generatePage(input()));
    });

    it('does not depend on the order parts were written in', () => {
        const reordered = input({
            release: {
                ...input().release,
                parts: {
                    'process-monitor': { version: '2.0.0', digest: 'sha256:monitor' },
                    chrome: { version: '1.0.0', digest: 'sha256:chrome' },
                },
            },
        });

        expect(generatePage(reordered)).toEqual(generatePage(input()));
    });
});

describe('one kernel, one URL', () => {
    it('maps the framework specifier to the mounted kernel', () => {
        const html = fileOf(generatePage(input()), 'index.html');

        expect(html).toContain('"importmap"');
        expect(html).toContain('"@flybyme/mesh-web": "/_a/kernel/index.js"');
    });

    it('imports the kernel from that same URL in the boot module', () => {
        // If these two ever disagreed, a part's bare import and the boot module's import would
        // resolve to different copies — and every capability lookup would silently find the wrong
        // registry.
        const files = generatePage(input());
        const html = fileOf(files, 'index.html');
        const boot = fileOf(files, 'boot.js');

        const mapped = /"@flybyme\/mesh-web": "([^"]+)"/.exec(html)?.[1];
        expect(boot).toContain(`import { start } from '${mapped!}'`);
    });
});

describe('the boot module', () => {
    it('imports every part at its own hash', () => {
        const boot = fileOf(generatePage(input()), 'boot.js');

        expect(boot).toContain("from '/_a/chrome/index.js'");
        expect(boot).toContain("from '/_a/monitor/index.js'");
    });

    it('names every part, so the kernel can resolve the order itself', () => {
        // The order in this array is deliberately not the order they start: the kernel reads that
        // off what each part provides and consumes.
        const boot = fileOf(generatePage(input()), 'boot.js');

        expect(boot).toContain("id: 'chrome'");
        expect(boot).toContain("id: 'process-monitor'");
    });

    it('reads the API from the document rather than baking it in', () => {
        // The same boot module then works behind a proxy that rewrote the origin — and, more to the
        // point, one artifact serves every site that chooses it.
        const boot = fileOf(generatePage(input()), 'boot.js');

        expect(boot).toContain('document.documentElement.dataset.api');
        expect(boot).not.toContain('console.surfdns.net');
    });

    it('carries policy, which is why changing it rebuilds nothing', () => {
        expect(fileOf(generatePage(input()), 'boot.js')).toContain('"window-manager/mode": "tiled"');
    });
});

describe('the page', () => {
    it('puts the api where the document can be asked for it', () => {
        expect(fileOf(generatePage(input()), 'index.html'))
            .toContain('data-api="https://console.surfdns.net/api"');
    });

    it('links the kernel\'s stylesheet, because the kernel owns the rules', () => {
        expect(fileOf(generatePage(input()), 'index.html'))
            .toContain('href="/_a/kernel/kernel.css"');
    });

    it('links the kernel stylesheet first and part stylesheets in canonical composition order', () => {
        const withStyles = input({
            partStyles: {
                chrome: ['chrome.css'],
                'process-monitor': ['monitor.css'],
            },
        });
        const html = fileOf(generatePage(withStyles), 'index.html');

        const kernelIndex = html.indexOf('href="/_a/kernel/kernel.css"');
        const chromeIndex = html.indexOf('href="/_a/chrome/chrome.css"');
        const monitorIndex = html.indexOf('href="/_a/monitor/monitor.css"');

        expect(kernelIndex).toBeGreaterThan(-1);
        expect(chromeIndex).toBeGreaterThan(-1);
        expect(monitorIndex).toBeGreaterThan(-1);

        expect(kernelIndex).toBeLessThan(chromeIndex);
        expect(chromeIndex).toBeLessThan(monitorIndex);
    });

    it('a part with no stylesheet changes nothing about the page', () => {
        const withoutStyles = input();
        const withEmptyStyles = input({
            partStyles: {
                chrome: [],
                'process-monitor': [],
            },
        });
        expect(generatePage(withEmptyStyles)).toEqual(generatePage(withoutStyles));
    });

    it('writes the theme as custom properties, because the site owns the values', () => {
        const html = fileOf(generatePage(input()), 'index.html');

        expect(html).toContain('--surface: #161b22;');
        expect(html).toContain('--ink: #e6edf3;');
    });

    it('has no element for a part to find by id', () => {
        // Five undeclared contracts between a bundle and a hand-written page is what this replaces.
        // The kernel creates what it mounts into.
        expect(fileOf(generatePage(input()), 'index.html')).not.toContain('id="console"');
    });
});

describe('what a crawler reads', () => {
    // The entire reason the page is generated per request rather than built as an artifact. A title
    // set by script after boot is a title a crawler that does not run JavaScript never sees — and
    // this is a window manager, so what a part renders is invisible to one anyway.
    const head = (over: Record<string, unknown>) =>
        fileOf(generatePage(input({ site: { ...input().site, ...over } })), 'index.html');

    it('puts the title in the document', () => {
        expect(head({ title: 'surfdns console' })).toContain('<title>surfdns console</title>');
    });

    it('falls back to the application label rather than an empty title', () => {
        expect(head({ title: '' })).toContain('<title>surfdns-console</title>');
    });

    it('writes description and og tags when there is a description', () => {
        const html = head({ description: 'Operate your zones.' });

        expect(html).toContain('<meta name="description" content="Operate your zones.">');
        expect(html).toContain('og:description');
    });

    it('omits the description tags entirely when there is none', () => {
        // An empty `content=""` is worse than absent: it tells a crawler the page has been described
        // and that the description is nothing.
        expect(head({ description: '' })).not.toContain('name="description"');
    });

    it('writes a canonical link when the site names one', () => {
        expect(head({ canonical: 'https://console.surfdns.net/' }))
            .toContain('<link rel="canonical" href="https://console.surfdns.net/">');
    });

    it('lets a site refuse indexing', () => {
        // Staging and production may sit on one release, identical but for this record. Without it
        // they compete for the same search results.
        expect(head({ indexable: false })).toContain('content="noindex, nofollow"');
        expect(head({ indexable: true })).not.toContain('noindex');
    });

    it('escapes metadata into attributes', () => {
        const html = head({ title: 'a"b', description: '</head><script>x' });

        expect(html).toContain('content="a&quot;b"');
        expect(html).not.toContain('<script>x');
    });
});

describe('a site cannot write CSS into a page it does not own', () => {
    it('refuses a theme value that would escape its declaration', () => {
        const escaping = input({
            site: { ...input().site, theme: { '--surface': 'red } body { display: none' } },
        });

        expect(() => generatePage(escaping)).toThrow(PageError);
    });

    it('refuses a token name that is not a custom property', () => {
        const bad = input({ site: { ...input().site, theme: { background: 'red' } } });
        expect(() => generatePage(bad)).toThrow(PageError);
    });

    it('escapes the application name into the title', () => {
        const injected = input({ site: { ...input().site, application: '</title><script>x' } });
        const html = fileOf(generatePage(injected), 'index.html');

        expect(html).toContain('&lt;/title&gt;&lt;script&gt;x');
        expect(html).not.toContain('<script>x');
    });
});
