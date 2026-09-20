import { defineContract, defineCrud, defineEvent, z } from '@flybyme/mesh';

import { ticketSchema } from '../schema/ticket.js';

export const ticketCrud = defineCrud('identity.ticket', ticketSchema, {
    pluralPath: 'tickets',
    unique: [{ fields: 'token', scope: 'global' }],
    visibility: {},
    // The generated resolve-by-id is renamed out of the way: `ticketResolveContract` below owns
    // the name `identity.ticket.resolve`, and resolves by *token*, which is what that key has
    // always meant at runtime. Both used to be declared under the same key and the collision was
    // settled by whichever registered last -- invisibly under ServiceModule's plain map, and with
    // the generated types and the contract registry disagreeing about which one won. Nothing calls
    // the by-id version; giving it its own name is what makes the override stop being an accident.
    actions: { resolve: 'resolveById' },
    dependencies: [],
    filePath: 'src/identity/contracts/ticket.contract.ts',
    permissions: [],
});

export type Ticket = z.infer<typeof ticketCrud.outputSchema>;

export const TicketRevokedEventSchema = z.object({
    id: z.string().describe('The id of the ticket that was revoked'),
    userId: z.string().describe('Whose ticket this is'),
    tokenId: z.string().describe('The token that was revoked'),
    revokedAt: z.number().describe('When the ticket was revoked, as a unix timestamp in milliseconds'),
    revokedReason: z.string().optional().describe('The reason for revocation'),
});

export const ticketRevokedEvent = defineEvent(
    'identity.ticket.revoked',
    TicketRevokedEventSchema,
    {
        scopedBy: 'userId',
    }
);

export type TicketRevokedEvent = z.infer<typeof TicketRevokedEventSchema>;

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
    filePath: 'src/identity/tools/issueTicket.ts', concurrency: 'on-demand', permissions: [],
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
    filePath: 'src/identity/tools/validateTicket.ts', concurrency: 'on-demand', permissions: [],
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
    filePath: 'src/identity/tools/revokeTicket.ts', concurrency: 'on-demand', permissions: [],
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
    filePath: 'src/identity/tools/signOut.ts', concurrency: 'on-demand', permissions: [],
    print: () => 'signed out',
});

export type SignOutInput = z.infer<typeof ticketSignOutContract.inputSchema>;
export type SignOutOutput = z.infer<typeof ticketSignOutContract.outputSchema>;


/**
 * Resolve a ticket to a user
 */

export const ticketResolveInputSchema = z.object({
    token: z.string().min(1).describe('The ticket to resolve'),
}).describe('Resolve a ticket to a user');

export const ticketResolveOutputSchema = z.object({
    ticket: ticketSchema.optional().describe('The ticket, if it exists and is valid'),
}).describe('The result of resolving a ticket');

export const ticketResolveContract = defineContract({
    domain: 'identity.ticket',
    action: 'resolve',
    description: 'Resolve a ticket to a user',
    inputSchema: ticketResolveInputSchema,
    outputSchema: ticketResolveOutputSchema,
    rest: { method: 'POST', path: '/identity/ticket/resolve' },
    filePath: 'src/identity/tools/resolveTicket.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => (o.ticket !== undefined ? `resolved: ${o.ticket.userId}` : 'invalid'),
});

export type TicketResolveInput = z.infer<typeof ticketResolveContract.inputSchema>;
export type TicketResolveOutput = z.infer<typeof ticketResolveContract.outputSchema>;

