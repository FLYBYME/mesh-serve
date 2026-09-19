import { z, defaultPrint, defineContract, defineEvent } from '@flybyme/mesh';

export const SiteEventSchema = z.object({
    siteId: z.string(),
});

export const siteEvent = defineEvent('cdn.site_updated', SiteEventSchema);

export const siteComposeContract = defineContract({
    domain: 'cdn',
    action: 'compose',
    description: 'Compose site deployment',
    inputSchema: z.object({ siteId: z.string() }),
    outputSchema: z.object({ ok: z.boolean() }),
    rest: { method: 'POST', path: '/cdn/compose' },
    filePath: 'test/fixtures/split-domain/site.contract.ts', concurrency: 'on-demand', permissions: [],
    print: defaultPrint,
});
