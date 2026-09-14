import { z } from 'zod';

export const exposeSchema = z.object({
  tenantId: z.string().describe('The organization that owns this site'),
  siteId: z.string().describe('The serve.site this exposure belongs to'),
  contract: z.string().describe('The domain.action key being exposed, e.g. "identity.whoami"'),
  role: z.string().optional().describe('An identity.role key required to call this contract; absent (with permission also absent) means public'),
  permission: z.string().optional().describe('A specific identity.grant permission key required to call this contract; at most one of role or permission is set'),
}).describe('One contract this site\'s api is allowed to serve, and at what gate');
