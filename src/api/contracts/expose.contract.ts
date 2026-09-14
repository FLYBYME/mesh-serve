import { defineContract, defineCrud, z } from '@flybyme/mesh';

import { exposeSchema } from '../schema/expose.js';

export const exposeCrud = defineCrud('serve.expose', exposeSchema, {
    pluralPath: 'exposes',
    scopedBy: 'tenantId',
    unique: [{ fields: ['siteId', 'contract'], scope: 'scoped' }],
    visibility: {},
    dependencies: ['serve.site'],
});

export type Expose = z.infer<typeof exposeCrud.outputSchema>;

export const addInputSchema = z.object({
    siteId: z.string().min(1).describe('The serve.site to expose this contract on'),
    contract: z.string().min(1).describe('The domain.action key to expose, e.g. "identity.whoami"'),
    role: z.string().optional().describe('An identity.role key required to call this; at most one of role or permission is set'),
    permission: z.string().optional().describe('Triggers an identity.permits check against the caller\'s resolved role permissions; at most one of role or permission is set'),
}).describe('Expose a contract on a site, gated by role, permission, or neither for public');

export const addOutputSchema = exposeCrud.get.outputSchema;

export const exposeAddContract = defineContract({
    domain: 'serve.expose',
    action: 'add',
    description: 'Expose a contract on a site, gated by role, permission, or neither for public.',
    inputSchema: addInputSchema,
    outputSchema: addOutputSchema,
    rest: { method: 'POST', path: '/expose' },
    visibility: 'public',
    destructive: true,
    print: (o) => `${o.contract} on ${o.siteId ?? '(default)'}`,
});

export type AddInput = z.infer<typeof exposeAddContract.inputSchema>;
export type AddOutput = z.infer<typeof exposeAddContract.outputSchema>;

export const removeInputSchema = z.object({
    siteId: z.string().min(1).describe('The serve.site the exposure belongs to'),
    contract: z.string().min(1).describe('The domain.action key to stop exposing'),
}).describe('Remove one exposed contract');

export const removeOutputSchema = z.object({
    removed: z.literal(true).describe('Always true; the call throws rather than answering false'),
}).describe('The result of removing an exposure');

export const exposeRemoveContract = defineContract({
    domain: 'serve.expose',
    action: 'remove',
    description: 'Remove one exposed contract.',
    inputSchema: removeInputSchema,
    outputSchema: removeOutputSchema,
    rest: { method: 'DELETE', path: '/expose/:siteId/:contract' },
    visibility: 'public',
    destructive: true,
    print: () => 'removed',
});

export type RemoveInput = z.infer<typeof exposeRemoveContract.inputSchema>;
export type RemoveOutput = z.infer<typeof exposeRemoveContract.outputSchema>;
