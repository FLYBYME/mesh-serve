import { z } from 'zod';

export const callerSchema = z.object({
  userId: z.string().describe('The ID of the user'),
  roles: z.array(z.string()).describe('Roles held by the caller'),
  provisional: z.boolean().optional().describe('Created by the platform, not yet claimed. Can only set password'),
  agent: z.string().optional().describe('The API token\'s name, when it arrived on one. Why a token is not a person'),
}).describe('A resolved caller, exactly this and nothing else');
