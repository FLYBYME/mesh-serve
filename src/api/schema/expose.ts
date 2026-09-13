import { z } from 'zod';

export const exposeSchema = z.object({
  siteId: z.string(),
  tenantId: z.string(),
  contract: z.string().describe('The contract key, e.g. identity.ticket.issue'),
  auth: z.enum(['public', 'authenticated']).optional(),
  permission: z.string().optional(),
  errors: z.array(z.string()).optional(),
});
