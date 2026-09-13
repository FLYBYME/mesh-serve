import { z } from 'zod';

export const grantSchema = z.object({
  roleKey: z.string().describe('The role this grant applies to'),
  contract: z.string().describe('A pattern matching contracts — e.g. identity.user.find, serve.part.*'),
  description: z.string().optional().describe('Optional description of the grant'),
}).describe('A roleKey and contract pair; update is internal on purpose');
