import { z } from 'zod';

export const apiTokenSchema = z.object({
  tokenHash: z.string().describe('Hash of the API token'),
  name: z.string().describe('Named so it can be revoked alone'),
  userId: z.string().describe('The user this token acts as'),
  organizationId: z.string().optional().describe('Optional organization scope for the token'),
  roles: z.array(z.string()).describe('Roles granted to this token'),
  createdAt: z.date().describe('When the token was created'),
  lastUsedAt: z.date().optional().describe('When the token was last used'),
  expiresAt: z.date().optional().describe('When the token expires'),
  revokedAt: z.date().optional().describe('When the token was revoked'),
}).describe('A credential issued to a program; carries agent into the caller');
