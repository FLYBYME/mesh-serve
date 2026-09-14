import { z } from 'zod';

export const exposeSchema = z.object({
  tenantId: z.string().optional().describe('The organization that owns this row; absent means a cluster-wide row, not owned by any tenant'),
  siteId: z.string().optional().describe('The serve.site this exposure belongs to; absent means it is not tied to any site -- e.g. the always-on default exposure served on the bootstrap host'),
  contract: z.string().describe('The domain.action key being exposed, e.g. "identity.whoami"'),
  role: z.string().optional().describe('An identity.role key the caller must effectively hold (checked via identity.hasRole); absent (with permission also absent) means public'),
  permission: z.string().optional().describe('Triggers an identity.permits check against the caller\'s resolved role permissions for this contract; at most one of role or permission is set'),
}).describe('One contract an api is allowed to serve, and at what gate');
