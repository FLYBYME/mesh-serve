import { defineContract, defineCrud, defineEvent, z } from '@flybyme/mesh';

import { userSchema } from '../schema/user.js';

export const userCrud = defineCrud('identity.user', userSchema, {
    pluralPath: 'users',
    unique: [{ fields: 'email', scope: 'global' }],
    visibility: {},
    dependencies: [],
    filePath: 'src/identity/contracts/user.contract.ts',
    permissions: [],
});

export type User = z.infer<typeof userCrud.outputSchema>;

export const userSignedOutEventSchema = z.object({
    userId: z.string().describe('The id of the account that was signed out'),
});

export const userSignedOutEvent = defineEvent(
    'identity.user.signed_out',
    userSignedOutEventSchema,
    {
        scopedBy: 'userId',
    }
);

export type UserSignedOutEvent = z.infer<typeof userSignedOutEventSchema>;

export const registerInputSchema = z.object({
    email: z.string().email().describe('The email address for the new account'),
    password: z.string().min(8).describe('At least eight characters'),
    displayName: z.string().min(1).describe('The name shown for this account'),
}).describe('Create an account');

export const registerOutputSchema = z.object({
    userId: z.string().describe('The new account\'s id'),
}).describe('The created account');

export const userRegisterContract = defineContract({
    domain: 'identity.user',
    action: 'register',
    description: 'Create an account.',
    inputSchema: registerInputSchema,
    outputSchema: registerOutputSchema,
    rest: { method: 'POST', path: '/identity/register' },
    visibility: 'public',
    destructive: true,
    filePath: 'src/identity/tools/register.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => `registered ${o.userId}`,
});

export type RegisterInput = z.infer<typeof userRegisterContract.inputSchema>;
export type RegisterOutput = z.infer<typeof userRegisterContract.outputSchema>;

export const setPasswordInputSchema = z.object({
    password: z.string().min(12).describe('At least twelve characters. Yours to choose'),
}).describe('Set your own password');

export const setPasswordOutputSchema = z.object({
    ok: z.literal(true).describe('Always true; the call throws rather than answering false'),
    claimed: z.boolean().describe('True when this call claimed a provisional account'),
}).describe('The result of setting a password');

export const userSetPasswordContract = defineContract({
    domain: 'identity.user',
    action: 'setPassword',
    description: 'Set your own password. Claims a provisional account.',
    inputSchema: setPasswordInputSchema,
    outputSchema: setPasswordOutputSchema,
    rest: { method: 'POST', path: '/identity/password' },
    visibility: 'public',
    destructive: true,
    filePath: 'src/identity/tools/setPassword.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => (o.claimed ? 'password set, account claimed' : 'password set'),
});

export type SetPasswordInput = z.infer<typeof userSetPasswordContract.inputSchema>;
export type SetPasswordOutput = z.infer<typeof userSetPasswordContract.outputSchema>;

export const grantRoleInputSchema = z.object({
    userId: z.string().min(1).optional().describe('The account to grant or revoke a role on, by id'),
    email: z.string().email().optional().describe('The account to grant or revoke a role on, by email'),
    role: z.string().min(1).describe('A cluster-scoped role key, e.g. operator'),
    granted: z.boolean().default(true).describe('False revokes the role instead of granting it'),
}).describe('Change one cluster-scoped role on an account');

export const grantRoleOutputSchema = z.object({
    userId: z.string().describe('The account that was changed'),
    roles: z.array(z.string()).describe('Every cluster role the account holds afterwards'),
    changed: z.boolean().describe('False when the account already held (or lacked) the role'),
}).describe('The account\'s roles after the change');

export const userGrantRoleContract = defineContract({
    domain: 'identity.user',
    action: 'grantRole',
    description: 'Grant or revoke a cluster-scoped role on an account.',
    inputSchema: grantRoleInputSchema,
    outputSchema: grantRoleOutputSchema,
    rest: { method: 'POST', path: '/identity/roles' },
    dependencies: ['identity.role'],
    visibility: 'public',
    destructive: true,
    // Grants any role to any account, with no check of its own -- the direct escalation path.
    // Until now the only thing standing between it and an anonymous caller was that nobody had
    // written a serve.expose row for it without a role.
    filePath: 'src/identity/tools/grantRole.ts', concurrency: 'on-demand', permissions: ['operator'],
    print: (o) => `${o.userId}: ${o.roles.join(', ') || 'no roles'}`,
});

export type GrantRoleInput = z.infer<typeof userGrantRoleContract.inputSchema>;
export type GrantRoleOutput = z.infer<typeof userGrantRoleContract.outputSchema>;
