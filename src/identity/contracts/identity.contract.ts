import { defineContract, z } from '@flybyme/mesh';

export const whoamiInputSchema = z.object({}).describe('No input; the caller is read from the ticket');

export const whoamiOutputSchema = z.object({
    userId: z.string().describe('The caller\'s id'),
    email: z.string().describe('The caller\'s email'),
    displayName: z.string().describe('The caller\'s display name'),
    roles: z.array(z.string()).describe('Cluster-scoped roles held directly on the account'),
    organizations: z.array(z.object({
        organizationId: z.string().describe('The organization\'s id'),
        name: z.string().describe('The organization\'s display name'),
        roleKey: z.string().describe('The caller\'s role in this organization'),
    })).describe('Every organization the caller belongs to, and their role in each'),
}).describe('Who the caller is');

export const whoamiContract = defineContract({
    domain: 'identity',
    action: 'whoami',
    description: 'Who the caller is, and which organizations they belong to.',
    inputSchema: whoamiInputSchema,
    outputSchema: whoamiOutputSchema,
    rest: { method: 'GET', path: '/identity/whoami' },
    dependencies: ['identity.user', 'identity.membership', 'identity.organization'],
    visibility: 'public',
    filePath: 'src/identity/tools/whoami.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => `${o.displayName} <${o.email}>`,
});

export type WhoamiInput = z.infer<typeof whoamiContract.inputSchema>;
export type WhoamiOutput = z.infer<typeof whoamiContract.outputSchema>;

export const permitsInputSchema = z.object({
    userId: z.string().min(1).describe('The account making the call'),
    contract: z.string().min(1).describe('The contract key being called, e.g. serve.expose.create'),
    organizationId: z.string().optional().describe('The organization this call is happening in, if any -- account roles are king: an org-scoped role only ever comes from identity.membership, and can never stand in for a global one'),
}).describe('Whether this account may call a contract, in this organization context; roles are resolved fresh, never trusted from a caller-supplied list');

export const permitsOutputSchema = z.object({
    permitted: z.boolean().describe('True only on an explicit grant; anything else is a refusal'),
}).describe('Whether the call is permitted');

export const permitsContract = defineContract({
    domain: 'identity',
    action: 'permits',
    description: 'Whether this account may call a contract, in this organization.',
    inputSchema: permitsInputSchema,
    outputSchema: permitsOutputSchema,
    rest: { method: 'POST', path: '/identity/permits' },
    dependencies: ['identity.role', 'identity.membership', 'identity.user'],
    filePath: 'src/identity/tools/permits.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => (o.permitted ? 'permitted' : 'denied'),
});

export type PermitsInput = z.infer<typeof permitsContract.inputSchema>;
export type PermitsOutput = z.infer<typeof permitsContract.outputSchema>;

export const hasRoleInputSchema = z.object({
    userId: z.string().min(1).describe('The account to check'),
    role: z.string().min(1).describe('The role key required'),
    organizationId: z.string().optional().describe('The organization this call is happening in, if any'),
}).describe('Whether this account effectively holds a role, in this organization context');

export const hasRoleOutputSchema = z.object({
    granted: z.boolean().describe('True if the account holds this role directly or via same-scope inheritance'),
}).describe('Whether the role is held');

export const hasRoleContract = defineContract({
    domain: 'identity',
    action: 'hasRole',
    description: 'Whether this account effectively holds a role, in this organization.',
    inputSchema: hasRoleInputSchema,
    outputSchema: hasRoleOutputSchema,
    rest: { method: 'POST', path: '/identity/hasRole' },
    dependencies: ['identity.role', 'identity.membership', 'identity.user'],
    filePath: 'src/identity/tools/hasRole.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => (o.granted ? 'granted' : 'denied'),
});

export type HasRoleInput = z.infer<typeof hasRoleContract.inputSchema>;
export type HasRoleOutput = z.infer<typeof hasRoleContract.outputSchema>;
