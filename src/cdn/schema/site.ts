import { z } from 'zod';

export const siteSchema = z.object({
  host: z.string().describe('The frontend hostname that resolves to this site\'s cdn; normalized by lowercasing, stripping port and trailing dot'),
  apiId: z.string().optional().describe('The serve.api backing this site, if any -- absent means this site calls no exposed contracts of its own'),
  mcpHost: z.string().describe('The hostname that resolves to this site\'s mcp endpoint'),
  tenantId: z.string().describe('The organization that owns this site'),
  releaseHash: z.string().optional().describe('The release this site serves; absent means not deployed yet'),
  application: z.string().describe('Namespaces this page\'s settings, so two Applications cannot collide in one backing store'),
  policy: z.record(z.string(), z.unknown()).describe('Values frozen into this deployment, e.g. { "window-manager/mode": "tiled" } -- matches mesh-web\'s BuildPolicy'),
  open: z.array(z.object({
    application: z.string().describe('Which Application to open'),
    views: z.array(z.string()).optional().describe('Which views of it; absent means none open'),
  })).optional().describe('Absent means every Application in the composition, with no views open'),
  theme: z.record(z.string(), z.string()).describe('CSS custom property values; the kernel owns the rules, the site owns the values'),
  title: z.string().describe('Falls back to application when empty'),
  description: z.string().describe('Empty means no description meta tags'),
  canonical: z.string().optional().describe('The canonical URL for this page'),
  image: z.string().optional().describe('An og:image URL'),
  indexable: z.boolean().describe('False adds a noindex, nofollow meta tag'),
  maintenance: z.boolean().default(false).describe('True means the site is under maintenance; redirect all traffic to /.well-known/maintenance'),
}).describe('A hostname, what it composes, and how the page it serves looks');
