import { z } from 'zod';

export const ticketSchema = z.object({
  token: z.string().describe('The bearer token string'),
  userId: z.string().describe('The user holding this ticket'),
  roles: z.array(z.string()).describe('Resolved roles at the time of issue'),
  issuedAt: z.coerce.date().describe('When the ticket was issued'),
  expiresAt: z.coerce.date().describe('When the ticket expires'),
  via: z.string().describe('How the ticket was issued (e.g., login, password_reset)'),
  revokedAt: z.coerce.date().optional().describe('When the ticket was revoked, if applicable'),
  revokedReason: z.string().optional().describe('Why the ticket was revoked'),
}).describe('A bearer credential, revocable, with an expiry; opaque row, not a signed claim');
