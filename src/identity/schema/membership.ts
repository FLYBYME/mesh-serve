import { z } from 'zod';

export const membershipSchema = z.object({
  userId: z.string().describe('The account in this membership'),
  organizationId: z.string().describe('The organization this membership belongs to'),
  roleKey: z.string().describe('The role held by the user in this organization'),
  invitedBy: z.string().optional().describe('Who invited the user to this organization'),
  joinedAt: z.date().describe('When the user joined the organization'),
}).describe("An account's place in one organization, carrying roles; scoped by organizationId, unique by userId");
