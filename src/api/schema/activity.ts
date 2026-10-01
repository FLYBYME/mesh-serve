import { z } from 'zod';

export const activitySchema = z.object({
  at: z.coerce.date().describe('When the call was made'),
  apiId: z.string().describe('The api it came through'),
  contract: z.string().describe('The domain.action called'),
  organizationId: z.string().describe('The organization it ran in (empty for none)'),
  actor: z.object({
    userId: z.string().describe('The account; empty when anonymous'),
    viaApiToken: z.boolean().describe('Made with an api token (an agent or a script), not a person\'s sign-in'),
    agentName: z.string().optional().describe('The api token\'s name, when viaApiToken'),
  }),
  outcome: z.enum(['ok', 'refused', 'failed', 'held']).describe('ok; refused (401/403); failed; held for approval'),
  status: z.number().int().describe('The HTTP status it ended with'),
  error: z.string().optional().describe('Why it failed or was refused, briefly'),
  input: z.string().describe('The input, summarized: secret-looking fields replaced, long values cut'),
  durationMs: z.number().int().nonnegative(),
  ip: z.string().describe('The connection\'s address'),
  forwardedFor: z.string().optional().describe('X-Forwarded-For as received -- what the edge proxy says the client was'),
  userAgent: z.string().optional(),
}).describe('One call that changed something, or that was refused -- the activity log; kept 90 days');
