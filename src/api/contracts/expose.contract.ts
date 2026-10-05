import { defineContract, defineCrud, z } from '@flybyme/mesh';

import { exposeSchema } from '../schema/expose.js';

export const exposeCrud = defineCrud('serve.expose', exposeSchema, {
    pluralPath: 'exposes',
    scopedBy: 'tenantId',
    unique: [{ fields: ['apiId', 'contract'], scope: 'scoped' }],
    // Reads only -- create/update/delete stay internal, behind the validated add/remove tools
    // (duplicate checks, public-contract checks, resolving the target api's tenant first).
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public',
    },
    dependencies: ['serve.api'],
    filePath: 'src/api/contracts/expose.contract.ts',
    permissions: [],
});

export type Expose = z.infer<typeof exposeCrud.outputSchema>;

export const addInputSchema = z.object({
    apiId: z.string().min(1).describe('The serve.api to expose this contract on'),
    kind: z.enum(['contract', 'event']).default('contract').describe('"event" streams an event over /events instead of exposing a contract'),
    contract: z.string().min(1).describe('The domain.action key to expose, e.g. "identity.whoami" -- or, for kind "event", the event name'),
    role: z.string().optional().describe('An identity.role key required to call this; at most one of role or permission is set'),
    permission: z.string().optional().describe('Triggers an identity.permits check against the caller\'s resolved role permissions; at most one of role or permission is set'),
    public: z.boolean().optional().describe('Say so to expose with no gate at all, when the contract itself demands no role either: anyone may then call it, acting as the api\'s own tenant. Refused without it'),
}).describe('Expose a contract on an api, gated by role, permission, or -- explicitly -- public');

export const addOutputSchema = exposeCrud.get.outputSchema;

export const exposeAddContract = defineContract({
    domain: 'serve.expose',
    action: 'add',
    description: 'Expose a contract on an api, gated by role, permission, or neither for public.',
    inputSchema: addInputSchema,
    outputSchema: addOutputSchema,
    rest: { method: 'POST', path: '/expose' },
    visibility: 'public',
    destructive: true,
    // Decides what is reachable over an api at all. Reaching this anonymously would mean being
    // able to publish anything, including this.
    filePath: 'src/api/tools/add.ts', concurrency: 'on-demand', permissions: ['operator'],
    print: (o) => `${o.kind === 'event' ? 'event ' : ''}${o.contract} on ${o.apiId}`,
});

export type AddInput = z.infer<typeof exposeAddContract.inputSchema>;
export type AddOutput = z.infer<typeof exposeAddContract.outputSchema>;

export const removeInputSchema = z.object({
    apiId: z.string().min(1).describe('The serve.api the exposure belongs to'),
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
    rest: { method: 'DELETE', path: '/expose/:apiId/:contract' },
    visibility: 'public',
    destructive: true,
    filePath: 'src/api/tools/remove.ts', concurrency: 'on-demand', permissions: ['operator'],
    print: () => 'removed',
});

export type RemoveInput = z.infer<typeof exposeRemoveContract.inputSchema>;
export type RemoveOutput = z.infer<typeof exposeRemoveContract.outputSchema>;

export const holdInputSchema = z.object({
    apiId: z.string().min(1).describe('The serve.api the exposure belongs to'),
    contract: z.string().min(1).describe('The exposed domain.action key'),
    hold: z.boolean().describe('false: a destructive call to it made with an api token runs at once (an operator\'s standing approval); true: held for a decision again, as every other'),
}).describe('Whether destructive token calls to one exposed contract are held');

export const exposeHoldContract = defineContract({
    domain: 'serve.expose',
    action: 'hold',
    description: 'Say whether destructive calls made with an api token to one exposed contract wait for an operator (the default) or run at once: the approved list, one row at a time. For the calls an agent must make to work at all, like a workspace daemon reporting in.',
    inputSchema: holdInputSchema,
    outputSchema: addOutputSchema,
    rest: { method: 'POST', path: '/expose/hold' },
    visibility: 'public',
    // Destructive, so a token can never approve itself: this call, made with a token, is held too.
    destructive: true,
    filePath: 'src/api/tools/hold.ts', concurrency: 'on-demand', permissions: ['operator'],
    print: (o) => `${o.contract} on ${o.apiId}: ${o.unheld === true ? 'runs at once for api tokens' : 'held for api tokens'}`,
});

export type HoldInput = z.infer<typeof exposeHoldContract.inputSchema>;
