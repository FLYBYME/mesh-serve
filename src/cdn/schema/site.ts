import { z } from 'zod';

export const siteSchema = z.object({
  host: z.string().describe('The hostname that resolves to this site; normalized by lowercasing, stripping port and trailing dot'),
  tenantId: z.string().describe('The organization that owns this site'),
  releaseHash: z.string().describe('The hash of the release this site points to'),
}).describe('A hostname pointed at a release; a public collection with an owner field');
