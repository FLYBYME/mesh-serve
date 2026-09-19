import { defineContract, defineCrud, z } from '@flybyme/mesh';

import { apiTokenSchema } from '../schema/apiToken.js';

export const apiTokenCrud = defineCrud('identity.apiToken', apiTokenSchema, {
    pluralPath: 'apiTokens',
    unique: [{ fields: 'tokenHash', scope: 'global' }],
    visibility: {},
    dependencies: [],
    filePath: 'src/identity/contracts/apiToken.contract.ts',
    permissions: [],
});

export type ApiToken = z.infer<typeof apiTokenCrud.outputSchema>;

export const issueInputSchema = z.object({
    name: z.string().min(1).describe('Named so it can be revoked alone'),
    userId: z.string().min(1).describe('The account this token acts as'),
    organizationId: z.string().optional().describe('Optional organization scope for the token'),
    roles: z.array(z.string()).optional().describe('Roles granted to this token'),
    expiresInMs: z.number().optional().describe('How long the token is valid for, from now'),
}).describe('Mint an API token for a principal');

export const issueOutputSchema = z.object({
    token: z.string().describe('The bearer token, shown once'),
    name: z.string().describe('The token\'s name'),
    userId: z.string().describe('The account this token acts as'),
    roles: z.array(z.string()).describe('Roles granted to this token'),
    expiresAt: z.number().optional().describe('When the token expires, as a unix timestamp in milliseconds'),
}).describe('A freshly minted API token');

export const apiTokenIssueContract = defineContract({
    domain: 'identity.apiToken',
    action: 'issue',
    description: 'Mint an API token for a principal.',
    inputSchema: issueInputSchema,
    outputSchema: issueOutputSchema,
    rest: { method: 'POST', path: '/identity/apiToken/issue' },
    dependencies: ['identity.user'],
    // Never marked public before this -- there was no way to mint an agent-facing api token over
    // HTTP at all, which made the agent half of the hold system (ApiService.placeOnHold)
    // theoretical: nothing could ever authenticate as `viaApiToken` in the first place.
    visibility: 'public',
    destructive: true,
    filePath: 'src/identity/contracts/apiToken.contract.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => `issued api token "${o.name}" for ${o.userId}`,
});

export type IssueInput = z.infer<typeof apiTokenIssueContract.inputSchema>;
export type IssueOutput = z.infer<typeof apiTokenIssueContract.outputSchema>;

export const validateInputSchema = z.object({
    token: z.string().min(1).describe('The API token to check'),
}).describe('Is this API token valid, and which principal does it represent');

export const validateOutputSchema = z.object({
    valid: z.boolean().describe('False for an expired, revoked, or unknown token'),
    userId: z.string().optional().describe('The account this token acts as, when valid'),
    roles: z.array(z.string()).optional().describe('Roles granted to this token'),
    name: z.string().optional().describe('The token\'s name'),
}).describe('Whether the token is valid, and what it represents');

export const apiTokenValidateContract = defineContract({
    domain: 'identity.apiToken',
    action: 'validate',
    description: 'Is this API token valid, and which principal does it represent.',
    inputSchema: validateInputSchema,
    outputSchema: validateOutputSchema,
    rest: { method: 'POST', path: '/identity/apiToken/validate' },
    filePath: 'src/identity/contracts/apiToken.contract.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => (o.valid ? `valid: ${o.userId ?? 'unknown'}` : 'invalid'),
});

export type ValidateInput = z.infer<typeof apiTokenValidateContract.inputSchema>;
export type ValidateOutput = z.infer<typeof apiTokenValidateContract.outputSchema>;
