import { z } from 'zod';

export const exposeSchema = z.object({
  tenantId: z.string().describe('The organization that owns this site'),
  siteId: z.string().describe('The serve.site this exposure belongs to'),
  contract: z.string().describe('The domain.action key being exposed, e.g. "identity.whoami"'),
  role: z.string().optional().describe('An identity.role key the caller must effectively hold (checked via identity.hasRole); absent (with permission also absent) means public'),
  permission: z.string().optional().describe('Triggers an identity.permits check against the caller\'s resolved role permissions for this contract; at most one of role or permission is set'),
}).describe('One contract this site\'s api is allowed to serve, and at what gate');
