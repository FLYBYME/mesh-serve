import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Logger, LogLevel } from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';
import { CdnGateway } from '../src/cdn/gateway.js';
import type { Site } from '../src/cdn/contracts/site.contract.js';

describe('CDN gateway pages, head synthesis, and sitemap', () => {
    let gateway: CdnGateway;
    let base = '';

    const siteWithPages: Site = {
        id: 'site-1',
        host: 'example.com',
        mcpHost: 'mcp.example.com',
        tenantId: 'tenant-1',
        application: 'app-site',
        policy: {},
        theme: {},
        title: 'Example Site',
        description: 'Site-wide description for example site',
        canonical: 'https://example.com/',
        image: 'https://example.com/og-image.png',
        organization: 'Example Org',
        lang: 'en',
        indexable: true,
        maintenance: false,
        releaseHash: 'rel-123',
        createdAt: new Date(),
        updatedAt: new Date(),
        pages: [
            {
                path: '/',
                title: 'Home | Example Site',
                description: 'Welcome to the home page of example site offering top infrastructure.',
                index: true,
            },
            {
                path: '/pricing',
                title: 'Pricing | Example Site',
                description: 'Transparent plans and predictable pricing for all your hosting requirements.',
                index: true,
            },
            {
                path: '/features',
                title: 'Features | Example Site',
                description: 'Full range of capabilities including automated deployments and monitoring.',
                index: true,
            },
            {
                path: '/sign-in',
                title: 'Sign In | Example Site',
                description: 'Access your account dashboard and configure domain settings securely.',
                index: false,
            },
            {
                path: '/escaped',
                title: 'Tom & Jerry <studio> "special"',
                description: 'Description with & and <script>alert(1)</script> entities.',
                index: true,
            },
        ],
    };

    const siteWithoutPages: Site = {
        id: 'site-2',
        host: 'nopages.example.com',
        mcpHost: 'mcp.nopages.example.com',
        tenantId: 'tenant-2',
        application: 'legacy-site',
        policy: {},
        theme: {},
        title: 'Legacy Site',
        description: 'Site-wide description for legacy site',
        canonical: 'https://nopages.example.com/',
        lang: 'en',
        indexable: true,
        maintenance: false,
        releaseHash: 'rel-123',
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    const sitesByHost: Record<string, Site> = {
        'example.com': siteWithPages,
        'nopages.example.com': siteWithoutPages,
    };

    beforeAll(async () => {
        const broker = {
            nodeID: 'test-node',
            logger: new Logger(LogLevel.ERROR),
            getProvider: () => undefined,
            call: async (contract: string, input: Record<string, unknown>) => {
                if (contract === 'serve.cdn.resolveHost') {
                    const host = input.host as string;
                    return sitesByHost[host];
                }
                if (contract === 'serve.release.getRelease') {
                    return {
                        hash: input.hash,
                        tenantId: 'tenant-1',
                        artifacts: [
                            {
                                id: 'art-1',
                                partId: 'part-1',
                                hash: 'art-hash-1',
                                assets: [
                                    { fileExtension: '.js', url: 'bundle.js', integrity: 'sha256-abc' },
                                    { fileExtension: '.css', url: 'bundle.css' },
                                ],
                            },
                        ],
                    };
                }
                if (contract === 'serve.part.resolve') {
                    return {
                        id: input.id,
                        kind: 'kernel',
                        key: 'platform/kernel',
                    };
                }
                throw new Error(`Unexpected contract call in test: ${contract}`);
            },
        } as unknown as IServiceBroker;

        gateway = new CdnGateway(broker);
        const bound = await gateway.start(0, '127.0.0.1');
        base = `http://${bound}`;
    }, 30000);

    afterAll(async () => {
        await gateway.stop();
    });

    const get = async (path: string, host: string = 'example.com') => {
        const res = await fetch(`${base}${path}`, {
            headers: { 'x-forwarded-host': host },
        });
        const text = await res.text();
        return { res, text };
    };

    it('serves listed page with its own title, description, canonical, and og:url', async () => {
        const { res, text } = await get('/pricing');
        expect(res.status).toBe(200);
        expect(text).toContain('<title>Pricing | Example Site</title>');
        expect(text).toContain('<meta name="description" content="Transparent plans and predictable pricing for all your hosting requirements.">');
        expect(text).toContain('<link rel="canonical" href="https://example.com/pricing">');
        expect(text).toContain('<meta property="og:url" content="https://example.com/pricing">');
        expect(text).toContain('<meta property="og:title" content="Pricing | Example Site">');
        expect(text).toContain('<meta property="og:description" content="Transparent plans and predictable pricing for all your hosting requirements.">');
        expect(text).toContain('<meta name="twitter:title" content="Pricing | Example Site">');
        expect(text).toContain('<meta name="twitter:description" content="Transparent plans and predictable pricing for all your hosting requirements.">');
        expect(text).not.toContain('<meta name="robots" content="noindex">');
    });

    it('serves the home page with its own title, description, and canonical address', async () => {
        const { res, text } = await get('/');
        expect(res.status).toBe(200);
        expect(text).toContain('<title>Home | Example Site</title>');
        expect(text).toContain('<meta name="description" content="Welcome to the home page of example site offering top infrastructure.">');
        expect(text).toContain('<link rel="canonical" href="https://example.com/">');
        expect(text).toContain('<meta property="og:url" content="https://example.com/">');
        expect(text).not.toContain('<meta name="robots" content="noindex">');
    });

    it('serves a page with index: false with a noindex robots meta tag', async () => {
        const { res, text } = await get('/sign-in');
        expect(res.status).toBe(200);
        expect(text).toContain('<meta name="robots" content="noindex">');
        expect(text).toContain('<title>Sign In | Example Site</title>');
        expect(text).toContain('<link rel="canonical" href="https://example.com/sign-in">');
    });

    it('serves an unlisted path with the site-wide head', async () => {
        const { res, text } = await get('/unlisted-path');
        expect(res.status).toBe(200);
        expect(text).toContain('<title>Example Site</title>');
        expect(text).toContain('<meta name="description" content="Site-wide description for example site">');
        expect(text).toContain('<link rel="canonical" href="https://example.com/">');
        expect(text).toContain('<meta property="og:url" content="https://example.com/">');
        expect(text).not.toContain('<meta name="robots" content="noindex">');
    });

    it('emits og:image, twitter:image, and summary_large_image when image is set', async () => {
        const { res, text } = await get('/');
        expect(res.status).toBe(200);
        expect(text).toContain('<meta property="og:image" content="https://example.com/og-image.png">');
        expect(text).toContain('<meta name="twitter:image" content="https://example.com/og-image.png">');
        expect(text).toContain('<meta name="twitter:card" content="summary_large_image">');
    });

    it('emits schema.org Organization JSON-LD when organization name is set', async () => {
        const { res, text } = await get('/');
        expect(res.status).toBe(200);
        const match = text.match(/<script type="application\/ld\+json">(.*?)<\/script>/);
        expect(match).not.toBeNull();
        const json = JSON.parse(match![1]!);
        expect(json).toEqual({
            '@context': 'https://schema.org',
            '@type': 'Organization',
            name: 'Example Org',
            url: 'https://example.com/',
            logo: 'https://example.com/og-image.png',
        });
    });

    it('escapes special HTML characters in title, description, and canonical', async () => {
        const { res, text } = await get('/escaped');
        expect(res.status).toBe(200);
        expect(text).toContain('<title>Tom &amp; Jerry &lt;studio&gt; &quot;special&quot;</title>');
        expect(text).toContain('<meta name="description" content="Description with &amp; and &lt;script&gt;alert(1)&lt;/script&gt; entities.">');
        expect(text).not.toContain('<script>alert(1)</script>');
    });

    it('lists every index: true page in sitemap.xml with home page first at priority 1.0 and others at 0.8', async () => {
        const { res, text } = await get('/sitemap.xml');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('application/xml');

        // Home page first with priority 1.0
        const expectedHome = '<url><loc>https://example.com/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>';
        expect(text).toContain(expectedHome);

        // Other index: true pages with priority 0.8
        expect(text).toContain('<url><loc>https://example.com/pricing</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>');
        expect(text).toContain('<url><loc>https://example.com/features</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>');
        expect(text).toContain('<url><loc>https://example.com/escaped</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>');

        // Excludes index: false page
        expect(text).not.toContain('/sign-in');

        // Home is first entry
        const homeIdx = text.indexOf(expectedHome);
        const pricingIdx = text.indexOf('https://example.com/pricing');
        expect(homeIdx).toBeLessThan(pricingIdx);
    });

    it('leaves a site without pages completely unchanged', async () => {
        const { res: pageRes, text: pageText } = await get('/pricing', 'nopages.example.com');
        expect(pageRes.status).toBe(200);
        expect(pageText).toContain('<title>Legacy Site</title>');
        expect(pageText).toContain('<meta name="description" content="Site-wide description for legacy site">');
        expect(pageText).toContain('<link rel="canonical" href="https://nopages.example.com/">');
        expect(pageText).toContain('<meta name="twitter:card" content="summary">');
        expect(pageText).not.toContain('<meta property="og:image"');
        expect(pageText).not.toContain('<script type="application/ld+json">');

        const { res: smRes, text: smText } = await get('/sitemap.xml', 'nopages.example.com');
        expect(smRes.status).toBe(200);
        expect(smText).toBe(
            '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://nopages.example.com/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n</urlset>'
        );
    });
});
