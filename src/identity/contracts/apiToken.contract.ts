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
    userId: z.string().min(1).optional().describe('The account this token acts as. Defaults to the caller; any other account requires the global operator role'),
    organizationId: z.string().optional().describe('Optional organization scope for the token; its account must be a member'),
    roles: z.array(z.string()).optional().describe('Roles granted to this token -- only roles its account already holds (in organizationId, when set)'),
    expiresInMs: z.number().int().positive().optional().describe('How long the token is valid for, from now'),
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
    filePath: 'src/identity/tools/issueApiToken.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => `issued api token "${o.name}" for ${o.userId}`,
});

export type IssueInput = z.infer<typeof apiTokenIssueContract.inputSchema>;
export type IssueOutput = z.infer<typeof apiTokenIssueContract.outputSchema>;

export const listInputSchema = z.object({
    userId: z.string().min(1).optional().describe('Whose tokens. Defaults to the caller; any other account requires the global operator role'),
}).describe('List the api tokens an account holds');

export const apiTokenSummarySchema = z.object({
    id: z.string(),
    name: z.string(),
    userId: z.string(),
    organizationId: z.string().optional(),
    roles: z.array(z.string()),
    createdAt: z.coerce.date(),
    lastUsedAt: z.coerce.date().optional(),
    expiresAt: z.coerce.date().optional(),
    revokedAt: z.coerce.date().optional(),
}).describe('An api token, without anything that could be used as it');

export const listOutputSchema = z.object({
    tokens: z.array(apiTokenSummarySchema),
}).describe('An account\'s api tokens');

export const apiTokenListContract = defineContract({
    domain: 'identity.apiToken',
    action: 'list',
    description: 'List an account\'s api tokens (names, scopes, expiry -- never the token itself).',
    inputSchema: listInputSchema,
    outputSchema: listOutputSchema,
    rest: { method: 'GET', path: '/identity/apiToken/list' },
    dependencies: ['identity.user'],
    visibility: 'public',
    filePath: 'src/identity/tools/listApiTokens.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => o.tokens.map((t) => `${t.name}${t.revokedAt ? ' (revoked)' : ''}`).join('\n') || 'no tokens',
});

export type ListInput = z.infer<typeof apiTokenListContract.inputSchema>;
export type ListOutput = z.infer<typeof apiTokenListContract.outputSchema>;

export const revokeInputSchema = z.object({
    id: z.string().min(1).optional().describe('The token to revoke, by id'),
    name: z.string().min(1).optional().describe('The token to revoke, by name'),
    userId: z.string().min(1).optional().describe('Whose token. Defaults to the caller; any other account requires the global operator role'),
}).describe('Revoke one api token, by id or by name');

export const revokeOutputSchema = z.object({
    revoked: z.number().int().describe('Tokens revoked by this call -- 0 when it already was'),
}).describe('What was revoked');

export const apiTokenRevokeContract = defineContract({
    domain: 'identity.apiToken',
    action: 'revoke',
    description: 'Revoke one of an account\'s api tokens, by id or name. It stops working at once.',
    inputSchema: revokeInputSchema,
    outputSchema: revokeOutputSchema,
    rest: { method: 'POST', path: '/identity/apiToken/revoke' },
    dependencies: ['identity.user'],
    visibility: 'public',
    destructive: true,
    filePath: 'src/identity/tools/revokeApiToken.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => `revoked ${o.revoked} token(s)`,
});

export type RevokeInput = z.infer<typeof apiTokenRevokeContract.inputSchema>;
export type RevokeOutput = z.infer<typeof apiTokenRevokeContract.outputSchema>;

export const validateInputSchema = z.object({
    token: z.string().min(1).describe('The API token to check'),
}).describe('Is this API token valid, and which principal does it represent');

export const validateOutputSchema = z.object({
    valid: z.boolean().describe('False for an expired, revoked, or unknown token'),
    userId: z.string().optional().describe('The account this token acts as, when valid'),
    organizationId: z.string().optional().describe('The token\'s own optional organization scope (apiTokenSchema.organizationId), when it has one'),
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
    filePath: 'src/identity/tools/validateApiToken.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => (o.valid ? `valid: ${o.userId ?? 'unknown'}` : 'invalid'),
});

export type ValidateInput = z.infer<typeof apiTokenValidateContract.inputSchema>;
export type ValidateOutput = z.infer<typeof apiTokenValidateContract.outputSchema>;
