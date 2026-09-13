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
    print: (o) => `${o.displayName} <${o.email}>`,
});

export type WhoamiInput = z.infer<typeof whoamiContract.inputSchema>;
export type WhoamiOutput = z.infer<typeof whoamiContract.outputSchema>;

export const permitsInputSchema = z.object({
    roles: z.array(z.string()).describe('The caller\'s roles to check'),
    contract: z.string().min(1).describe('The contract key being called, e.g. serve.site.deploy'),
    organizationId: z.string().optional().describe('The organization this call is scoped to, if any'),
}).describe('Whether a caller holding these roles may call a contract');

export const permitsOutputSchema = z.object({
    permitted: z.boolean().describe('True only on an explicit grant; anything else is a refusal'),
}).describe('Whether the call is permitted');

export const permitsContract = defineContract({
    domain: 'identity',
    action: 'permits',
    description: 'Whether a caller holding these roles may call a contract, in this organization.',
    inputSchema: permitsInputSchema,
    outputSchema: permitsOutputSchema,
    rest: { method: 'POST', path: '/identity/permits' },
    dependencies: ['identity.grant', 'identity.role'],
    print: (o) => (o.permitted ? 'permitted' : 'denied'),
});

export type PermitsInput = z.infer<typeof permitsContract.inputSchema>;
export type PermitsOutput = z.infer<typeof permitsContract.outputSchema>;
