import { z } from 'zod';

export const userSchema = z.object({
  email: z.string().email().describe('The primary email address of the account'),
  displayName: z.string().describe('The display name for the user'),
  passwordHash: z.string().optional().describe('Hidden field; the reason nothing on this platform can turn a user id into a name'),
  roles: z.array(z.string()).describe('Roles directly attached to the account, carrying permissions that apply everywhere'),
  provisional: z.boolean().optional().describe('A provisional account can do exactly one thing: set its own password'),
  suspendedAt: z.coerce.date().optional().describe('When the user was suspended'),
  suspendedReason: z.string().optional().describe('Reason for suspension'),
}).describe('A person or a machine that can hold a ticket; every action internal');
