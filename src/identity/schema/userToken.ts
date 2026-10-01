import { z } from 'zod';

export const userTokenSchema = z.object({
  userId: z.string().describe('The account the link is for'),
  email: z.string().describe('The address it was sent to, lower case'),
  purpose: z.enum(['reset', 'verify']).describe('Setting a new password, or proving the address'),
  tokenHash: z.string().describe('Hidden: the SHA-256 of the token in the link -- never the token'),
  expiresAt: z.coerce.date(),
  usedAt: z.coerce.date().optional().describe('When it was used; a used link never works again'),
}).describe('A one-time link sent to an account\'s address');
