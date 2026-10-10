import { defineContract, defineCrud, z } from '@flybyme/mesh';

import { userTokenSchema } from '../schema/userToken.js';
import { RESET_REQUESTED } from '../methods/userToken.js';

/** One-time links (methods/userToken.ts). Internal: nothing outside identity reads or writes them. */
export const userTokenCrud = defineCrud('identity.userToken', userTokenSchema, {
    pluralPath: 'user-tokens',
    visibility: {},
    dependencies: ['identity.user'],
    filePath: 'src/identity/contracts/userToken.contract.ts',
    permissions: [],
});

export const resetRequestInputSchema = z.object({
    email: z.string().trim().email().describe('The account\'s address (spaces around it are ignored)'),
    shownForMs: z.number().int().min(0).optional().describe('How long the form was on screen before it was sent: through the api, one sent within seconds is refused (api/methods/formLimit.ts)'),
}).describe('Ask for a link to set a new password');

export const resetRequestOutputSchema = z.object({
    message: z.string().describe(`Always: "${RESET_REQUESTED}" -- the same whether or not the address has an account`),
});

export const userResetRequestContract = defineContract({
    domain: 'identity.user',
    action: 'reset_request',
    description: 'Send a link to set a new password to an account\'s address. Answers the same whether or not the address has an account.',
    inputSchema: resetRequestInputSchema,
    outputSchema: resetRequestOutputSchema,
    rest: { method: 'POST', path: '/identity/password/reset' },
    visibility: 'public',
    destructive: true,
    dependencies: ['identity.user', 'identity.userToken'],
    filePath: 'src/identity/tools/userToken.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => o.message,
});

export const resetCompleteInputSchema = z.object({
    token: z.string().min(20).describe('The token from the link'),
    password: z.string().min(12).describe('The new password: at least twelve characters'),
}).describe('Set a new password with a reset link');

export const userResetCompleteContract = defineContract({
    domain: 'identity.user',
    action: 'reset_complete',
    description: 'Set a new password with a reset link; every session of the account is ended.',
    inputSchema: resetCompleteInputSchema,
    outputSchema: z.object({ ok: z.literal(true), signedOutSessions: z.number().int() }),
    rest: { method: 'POST', path: '/identity/password/reset/complete' },
    visibility: 'public',
    destructive: true,
    dependencies: ['identity.user', 'identity.userToken', 'identity.ticket'],
    filePath: 'src/identity/tools/userToken.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => `password set; ${o.signedOutSessions} sessions ended`,
});

export const userVerifyRequestContract = defineContract({
    domain: 'identity.user',
    action: 'verify_request',
    description: 'Send the caller a link that proves they read their account\'s email address.',
    inputSchema: z.object({}),
    outputSchema: z.object({ sent: z.boolean(), alreadyVerified: z.boolean() }),
    rest: { method: 'POST', path: '/identity/email/verify' },
    visibility: 'public',
    destructive: true,
    dependencies: ['identity.user', 'identity.userToken'],
    filePath: 'src/identity/tools/userToken.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => (o.alreadyVerified ? 'already verified' : o.sent ? 'link sent' : 'not sent'),
});

export const userVerifyCompleteContract = defineContract({
    domain: 'identity.user',
    action: 'verify_complete',
    description: 'Prove an email address with the link sent to it.',
    inputSchema: z.object({ token: z.string().min(20).describe('The token from the link') }),
    outputSchema: z.object({ ok: z.literal(true), email: z.string() }),
    rest: { method: 'POST', path: '/identity/email/verify/complete' },
    visibility: 'public',
    destructive: true,
    dependencies: ['identity.user', 'identity.userToken'],
    filePath: 'src/identity/tools/userToken.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => `verified ${o.email}`,
});

export type ResetRequestInput = z.infer<typeof userResetRequestContract.inputSchema>;
export type ResetRequestOutput = z.infer<typeof userResetRequestContract.outputSchema>;
export type ResetCompleteInput = z.infer<typeof userResetCompleteContract.inputSchema>;
export type ResetCompleteOutput = z.infer<typeof userResetCompleteContract.outputSchema>;
export type VerifyRequestOutput = z.infer<typeof userVerifyRequestContract.outputSchema>;
export type VerifyCompleteInput = z.infer<typeof userVerifyCompleteContract.inputSchema>;
export type VerifyCompleteOutput = z.infer<typeof userVerifyCompleteContract.outputSchema>;
