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
    shownForMs: z.number().int().min(0).optional().describe('How long the form was on screen before it was sent: through the api, one sent within seconds is refused (api/methods/formLimit.ts)'),
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

export const userRemoveInputSchema = z.object({
    userId: z.string().min(1).describe('The account to remove'),
}).describe('Remove an account');

export const userRemoveOutputSchema = z.object({
    userId: z.string(),
    email: z.string(),
    memberships: z.number().int().describe('Memberships removed with it'),
    sessions: z.number().int().describe('Sign-in tickets removed'),
    apiTokens: z.number().int().describe('Api tokens removed'),
    links: z.number().int().describe('Unused verification and password links removed'),
}).describe('The removed account');

/**
 * identity.user.remove -- an account taken away with everything that lets it act: its memberships,
 * sign-ins, api tokens and unused links. For junk (a bot's sign-up, 10-08), not for people leaving
 * an organization. Refuses an account that still owns an organization (remove or hand it over
 * first), one holding a platform role (take it away first), and the caller's own. Operator-only.
 */
export const userRemoveContract = defineContract({
    domain: 'identity.user',
    action: 'remove',
    description: 'Operator: removes an account with its memberships, sign-ins, api tokens and links. Not one that owns an organization, holds a platform role, or is your own.',
    inputSchema: userRemoveInputSchema,
    outputSchema: userRemoveOutputSchema,
    rest: { method: 'POST', path: '/identity/users/remove' },
    dependencies: ['identity.user', 'identity.organization', 'identity.membership', 'identity.ticket', 'identity.apiToken', 'identity.userToken'],
    visibility: 'public',
    destructive: true,
    filePath: 'src/identity/tools/removeUser.ts', concurrency: 'on-demand', permissions: ['operator'],
    print: (o) => `${o.email} removed, with ${o.memberships} memberships, ${o.sessions} sign-ins, ${o.apiTokens} api tokens, ${o.links} links`,
});

export type UserRemoveInput = z.infer<typeof userRemoveInputSchema>;
export type UserRemoveOutput = z.infer<typeof userRemoveOutputSchema>;

export type RegisterInput = z.infer<typeof userRegisterContract.inputSchema>;
export type RegisterOutput = z.infer<typeof userRegisterContract.outputSchema>;

export const setPasswordInputSchema = z.object({
    password: z.string().min(12).describe('At least twelve characters. Yours to choose'),
    currentPassword: z.string().optional().describe('Your password now -- required unless the account is provisional (still being claimed)'),
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

export const listUsersInputSchema = z.object({}).describe('No input; every account on the platform');

export const listUsersOutputSchema = z.object({
    users: z.array(z.object({
        id: z.string().describe('The account\'s id'),
        email: z.string().describe('The account\'s email'),
        displayName: z.string().describe('The account\'s display name'),
        roles: z.array(z.string()).describe('Cluster-scoped roles held directly on the account'),
        provisional: z.boolean().describe('True until the account\'s owner sets a password'),
        suspendedAt: z.coerce.date().optional().describe('When the account was suspended, if it is'),
        createdAt: z.coerce.date().optional().describe('When the account was made'),
        organizations: z.array(z.object({
            organizationId: z.string().describe('The organization\'s id'),
            name: z.string().describe('The organization\'s display name'),
            roleKey: z.string().describe('The account\'s role in it'),
        })).describe('Every organization the account belongs to'),
    })).describe('Every account, oldest first'),
}).describe('The platform\'s accounts');

export const userListContract = defineContract({
    domain: 'identity.user',
    action: 'list',
    // identity.user's own crud is internal because a row carries its password hash; this is the
    // operator's view of the same accounts with that field never read out.
    description: 'Every account on the platform and the organizations each belongs to (operator).',
    inputSchema: listUsersInputSchema,
    outputSchema: listUsersOutputSchema,
    rest: { method: 'GET', path: '/identity/users' },
    dependencies: ['identity.membership', 'identity.organization'],
    visibility: 'public',
    filePath: 'src/identity/tools/listUsers.ts', concurrency: 'on-demand', permissions: ['operator'],
    print: (o) => o.users.map((u) => `${u.email}  ${u.organizations.map((g) => `${g.name}:${g.roleKey}`).join(', ')}`).join('\n'),
});

export type ListUsersInput = z.infer<typeof userListContract.inputSchema>;
export type ListUsersOutput = z.infer<typeof userListContract.outputSchema>;

export type GrantRoleInput = z.infer<typeof userGrantRoleContract.inputSchema>;
export type GrantRoleOutput = z.infer<typeof userGrantRoleContract.outputSchema>;
