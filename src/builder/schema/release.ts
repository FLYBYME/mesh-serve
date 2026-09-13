import { z } from 'zod';

export const releaseSchema = z.object({
  hash: z.string().describe('The identity. Derived from its contents'),
  name: z.string().describe('Name of the release'),
  tenantId: z.string().describe('Whose release it is'),
  kernel: z.object({
    version: z.string().describe('The version for a person'),
    digest: z.string().describe('The digest for a machine'),
    import: z.string().optional().describe('The import specifier'),
  }).describe('One pinned artifact'),
  parts: z.record(z.string(), z.object({
    version: z.string().describe('The version for a person'),
    digest: z.string().describe('The digest for a machine'),
    import: z.string().optional().describe('The import specifier'),
  })).describe('{ id → pinned artifact }'),
  requires: z.array(z.string()).describe('Capabilities the whole thing needs'),
  policy: z.record(z.string(), z.any()).describe('{ key → value } enforced by CDN'),
  agentRoles: z.record(z.string(), z.array(z.string())).describe('{ role → contract[] }'),
  rolling: z.boolean().describe('Whether it follows its source automatically'),
  source: z.string().describe('What it was composed from'),
  supersededBy: z.string().optional().describe('Set when a newer release replaces it'),
  composedAt: z.date().describe('When it was composed'),
}).describe('A named set of versions that compose');
