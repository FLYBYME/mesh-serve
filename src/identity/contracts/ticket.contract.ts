import { defineContract, defineCrud, z } from '@flybyme/mesh';

import { ticketSchema } from '../schema/ticket.js';

export const ticketCrud = defineCrud('identity.ticket', ticketSchema, {
    pluralPath: 'tickets',
    unique: [{ fields: 'token', scope: 'global' }],
    visibility: {},
    dependencies: [],
});

export type Ticket = z.infer<typeof ticketCrud.outputSchema>;

export const issueInputSchema = z.object({
    email: z.string().email().describe('The account signing in'),
    password: z.string().min(1).describe('The account\'s current password'),
    via: z.string().optional().describe('Recorded on the ticket for an audit trail; does not change what is granted'),
}).describe('Exchange credentials for a bearer ticket');

export const issueOutputSchema = z.object({
    token: z.string().describe('The bearer ticket'),
    userId: z.string().describe('Whose ticket this is'),
    expiresAt: z.number().describe('When the ticket expires, as a unix timestamp in milliseconds'),
}).describe('A freshly issued ticket');

export const ticketIssueContract = defineContract({
    domain: 'identity.ticket',
    action: 'issue',
    description: 'Exchange credentials for a bearer ticket.',
    inputSchema: issueInputSchema,
    outputSchema: issueOutputSchema,
    rest: { method: 'POST', path: '/identity/ticket' },
    visibility: 'public',
    destructive: true,
    print: (o) => `ticket for ${o.userId}`,
});

export type IssueInput = z.infer<typeof ticketIssueContract.inputSchema>;
export type IssueOutput = z.infer<typeof ticketIssueContract.outputSchema>;

export const validateInputSchema = z.object({
    token: z.string().min(1).describe('The bearer ticket to check'),
}).describe('Is this ticket valid, and whose is it');

export const validateOutputSchema = z.object({
    valid: z.boolean().describe('False for an expired, revoked, or unknown ticket'),
    userId: z.string().optional().describe('Whose ticket this is, when valid'),
    roles: z.array(z.string()).optional().describe('The roles resolved at the time the ticket was issued'),
}).describe('Whether the ticket is valid, and whose it is');

export const ticketValidateContract = defineContract({
    domain: 'identity.ticket',
    action: 'validate',
    description: 'Is this ticket valid, and whose is it.',
    inputSchema: validateInputSchema,
    outputSchema: validateOutputSchema,
    rest: { method: 'POST', path: '/identity/ticket/validate' },
    print: (o) => (o.valid ? `valid: ${o.userId ?? 'unknown'}` : 'invalid'),
});

export type ValidateInput = z.infer<typeof ticketValidateContract.inputSchema>;
export type ValidateOutput = z.infer<typeof ticketValidateContract.outputSchema>;

export const revokeInputSchema = z.object({
    token: z.string().optional().describe('One ticket to revoke'),
    userId: z.string().optional().describe('Every ticket this account holds, to revoke them all'),
    reason: z.string().optional().describe('Recorded for an audit trail'),
}).describe('Revoke one ticket, or every ticket a principal holds');

export const revokeOutputSchema = z.object({
    revoked: z.number().describe('How many tickets this ended'),
    epoch: z.number().describe('The epoch to poll from to see this revocation'),
}).describe('The result of revoking tickets');

export const ticketRevokeContract = defineContract({
    domain: 'identity.ticket',
    action: 'revoke',
    description: 'Revoke one ticket, or every ticket a principal holds.',
    inputSchema: revokeInputSchema,
    outputSchema: revokeOutputSchema,
    rest: { method: 'POST', path: '/identity/ticket/revoke' },
    destructive: true,
    print: (o) => `revoked ${String(o.revoked)} at epoch ${String(o.epoch)}`,
});

export type RevokeInput = z.infer<typeof ticketRevokeContract.inputSchema>;
export type RevokeOutput = z.infer<typeof ticketRevokeContract.outputSchema>;

export const signOutInputSchema = z.object({
    token: z.string().min(1).describe('The caller\'s own ticket. Yours by definition: you had to hold it to send it'),
}).describe('End the calling session');

export const signOutOutputSchema = z.object({
    signedOut: z.literal(true).describe('Always true, whether or not the ticket was already invalid'),
}).describe('The session has ended');

export const ticketSignOutContract = defineContract({
    domain: 'identity.ticket',
    action: 'signOut',
    description: 'End the calling session.',
    inputSchema: signOutInputSchema,
    outputSchema: signOutOutputSchema,
    rest: { method: 'POST', path: '/identity/signOut' },
    visibility: 'public',
    destructive: true,
    print: () => 'signed out',
});

export type SignOutInput = z.infer<typeof ticketSignOutContract.inputSchema>;
export type SignOutOutput = z.infer<typeof ticketSignOutContract.outputSchema>;
