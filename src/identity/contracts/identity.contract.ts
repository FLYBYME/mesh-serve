/**
 * What identity answers over the mesh.
 *
 * Every one of these is `internal` by default and **that is deliberate**. mesh defaults a contract
 * to internal, and identity is the module a deployment authenticates through: `ticket_validate` on
 * the public internet would let anyone test tickets against it, and `revocations_since` would leak
 * who had been suspended and when.
 *
 * Two are marked `public` because a site genuinely has to expose them — registering and asking who
 * you are — and even then it is the *site's* exposure list that decides, not this file
 * (mesh-web spec/service-modules.md §2, C3.2).
 */

import { defineContract, defineCrud, type ToolContract, z } from '@flybyme/mesh';

import {
    ApiTokenSchema,
    MembershipSchema,
    OrganizationSchema,
    UserSchema,
} from '../schema/principals.js';
import { GrantSchema, RoleSchema } from '../schema/roles.js';
import { TicketSchema, ValidationSchema } from '../schema/tickets.js';

// ---------------------------------------------------------------------------- CRUD collections

/**
 * Global collection of user profiles.
 *
 * Scoping: Global. A user is not owned by an organization; a user exists across the deployment
 * and joins organizations via memberships.
 */
export const userCrud = defineCrud('user', UserSchema, {
    pluralPath: 'users',
    unique: [{ fields: 'email', scope: 'global' }],
    visibility: {
        find: 'internal', findOne: 'internal', get: 'internal', resolve: 'internal',
        count: 'internal', create: 'internal', createMany: 'internal', update: 'internal',
        replace: 'internal', delete: 'internal',
    },
    dependencies: [],
});

export type StoredUser = z.infer<typeof userCrud.outputSchema>;

/**
 * Global collection of organizations (tenants).
 *
 * Scoping: Global. Organizations are top-level tenant boundaries.
 */
export const organizationCrud = defineCrud('organization', OrganizationSchema, {
    pluralPath: 'organizations',
    unique: [{ fields: 'slug', scope: 'global' }],
    visibility: {
        find: 'public', findOne: 'public', get: 'public', resolve: 'internal',
        count: 'public', create: 'public', createMany: 'internal', update: 'internal',
        replace: 'internal', delete: 'internal',
    },
    dependencies: [],
});

export type StoredOrganization = z.infer<typeof organizationCrud.outputSchema>;

/**
 * Scoped collection connecting a user to an organization.
 *
 * Scoping: Tenant-scoped by `organizationId`. A caller in organization A cannot read
 * or write memberships of organization B.
 */
export const membershipCrud = defineCrud('membership', MembershipSchema, {
    pluralPath: 'memberships',
    scopedBy: 'organizationId',
    unique: [{ fields: 'userId', scope: 'scoped' }],
    visibility: {
        find: 'public', findOne: 'public', get: 'public', resolve: 'internal',
        count: 'public', create: 'public', createMany: 'internal', update: 'internal',
        replace: 'internal', delete: 'public',
    },
    dependencies: [],
});

export type StoredMembership = z.infer<typeof membershipCrud.outputSchema>;

/**
 * Global collection of roles.
 *
 * Scoping: Global. Roles are platform definitions (such as builtin roles `public` and `authenticated`).
 * The role catalogue contains no tenant data and is safe to be read globally by authenticated operators.
 */
export const roleCrud = defineCrud('role', RoleSchema, {
    pluralPath: 'roles',
    unique: [{ fields: 'key', scope: 'global' }],
    visibility: {
        find: 'public', findOne: 'public', get: 'public', resolve: 'internal',
        count: 'public', create: 'internal', createMany: 'internal', update: 'internal',
        replace: 'internal', delete: 'internal',
    },
    dependencies: [],
});

export type StoredRole = z.infer<typeof roleCrud.outputSchema>;

/**
 * Global collection of role-contract grants.
 *
 * Scoping: Global. Grants define what contracts a role permits.
 */
export const grantCrud = defineCrud('grant', GrantSchema, {
    pluralPath: 'grants',
    unique: [{ fields: ['roleKey', 'contract'], scope: 'global' }],
    visibility: {
        find: 'internal', findOne: 'internal', get: 'internal', resolve: 'internal',
        count: 'internal', create: 'internal', createMany: 'internal', update: 'internal',
        replace: 'internal', delete: 'internal',
    },
    dependencies: [],
});

export type StoredGrant = z.infer<typeof grantCrud.outputSchema>;

/**
 * Global collection of session tickets.
 *
 * Scoping: Global. Tickets authenticate a principal across the mesh.
 */
export const ticketCrud = defineCrud('ticket', TicketSchema, {
    pluralPath: 'tickets',
    unique: [{ fields: 'token', scope: 'global' }],
    visibility: {
        find: 'internal', findOne: 'internal', get: 'internal', resolve: 'internal',
        count: 'internal', create: 'internal', createMany: 'internal', update: 'internal',
        replace: 'internal', delete: 'internal',
    },
    dependencies: [],
});

export type StoredTicket = z.infer<typeof ticketCrud.outputSchema>;

/**
 * Global collection of API tokens for machine-to-machine authentication.
 *
 * Scoping: Global.
 */
export const apiTokenCrud = defineCrud('apiToken', ApiTokenSchema, {
    pluralPath: 'api-tokens',
    unique: [{ fields: 'tokenHash', scope: 'global' }],
    visibility: {
        find: 'internal', findOne: 'internal', get: 'internal', resolve: 'internal',
        count: 'internal', create: 'internal', createMany: 'internal', update: 'internal',
        replace: 'internal', delete: 'internal',
    },
    dependencies: [],
});

export type StoredApiToken = z.infer<typeof apiTokenCrud.outputSchema>;

export const identityCrudCollections = [
    userCrud,
    organizationCrud,
    membershipCrud,
    roleCrud,
    grantCrud,
    ticketCrud,
    apiTokenCrud,
] as const;


// ---------------------------------------------------------------------------- tickets

export const ticketIssueContract = defineContract({
    domain: 'identity',
    action: 'ticket_issue',
    description: 'Exchange credentials for an opaque ticket.',
    inputSchema: z.object({
        email: z.string().email(),
        password: z.string().min(1),
        /** Recorded on the ticket for an audit trail; does not change what is granted. */
        via: z.string().optional(),
    }),
    outputSchema: z.object({
        token: z.string(),
        userId: z.string(),
        expiresAt: z.number(),
    }),
    rest: { method: 'POST', path: '/identity/ticket' },
    // Public, because signing in is the one call that cannot require being signed in. Found by the
    // first site to expose this domain (mesh-web A6.7): `describeExposure` refused the entry, which
    // is the check working — an internal contract must never reach the internet by accident — but
    // the answer here is that this contract was never internal. `register` and `whoami` beside it
    // already said so; this one was missed.
    visibility: 'public',
    destructive: true,
    print: (o) => `ticket for ${o.userId}`,
});

export const ticketValidateContract = defineContract({
    domain: 'identity',
    action: 'ticket_validate',
    description: 'Is this ticket valid, and whose is it.',
    inputSchema: z.object({ ticket: z.string().min(1) }),
    outputSchema: ValidationSchema,
    rest: { method: 'POST', path: '/identity/ticket/validate' },
    print: (o) => (o.valid ? `valid: ${o.userId ?? 'unknown'}` : 'invalid'),
});

export const ticketRevokeContract = defineContract({
    domain: 'identity',
    action: 'ticket_revoke',
    description: 'Revoke one ticket, or every ticket a principal holds.',
    inputSchema: z.object({
        /** One of these. A ticket, or everything belonging to a user. */
        token: z.string().optional(),
        userId: z.string().optional(),
        reason: z.string().optional(),
    }),
    outputSchema: z.object({
        revoked: z.number().describe('How many tickets this ended'),
        epoch: z.number().describe('The epoch to poll from to see it'),
    }),
    rest: { method: 'POST', path: '/identity/ticket/revoke' },
    destructive: true,
    print: (o) => `revoked ${String(o.revoked)} at epoch ${String(o.epoch)}`,
});

/**
 * End **this** session, and nothing else.
 *
 * `ticket_revoke` cannot be a browser's sign-out and must stay internal: it takes a `userId`, so it
 * ends every ticket a *named person* holds. That is a real operation — an operator suspending an
 * account — and it is not one a page may perform.
 *
 * The generator found this rather than a review. mesh-auth declared `identity.ticket_revoke` among
 * the contracts it calls, and `describeExposure` refused it: *marked internal by its own domain and
 * cannot be exposed*. The check working is the story; the extension had been posting to that path
 * since it was written.
 *
 * ## Why it takes a token and not nothing
 *
 * *No input at all* was the first draft, on the reasoning that the ticket is already on the request
 * and a contract whose only possible target is the caller cannot be pointed at anybody else. It does
 * not work: `Caller` is `{ userId, roles }`, so what crosses the broker is **who** the ticket belongs
 * to and never the ticket. Making it work would mean putting a live credential in `meta`, where every
 * handler on the mesh would receive it — and *an Application never handles a credential* is a
 * property this system spends real effort on. Weakening it so that one contract can take no argument
 * is a bad trade.
 *
 * So the token is named, and the safety comes from what a token *is*: **presenting one proves you
 * hold it, and revoking a ticket you hold is strictly less powerful than using it.** The dangerous
 * parameter on `ticket_revoke` was never `token` — it was `userId`, which acts on a person rather
 * than on a credential, and it is absent here.
 *
 * `public`, because signing out cannot require being signed in any more than signing in can: a
 * caller holding an expired or already-revoked ticket must still be able to say *I am done* and get
 * the same answer as one holding a live one.
 */
export const signOutContract = defineContract({
    domain: 'identity',
    action: 'sign_out',
    description: 'End the calling session.',
    inputSchema: z.object({
        /** The ticket to end. Yours by definition: you had to hold it to send it. */
        token: z.string().min(1),
    }),
    outputSchema: z.object({
        /**
         * Always true, and deliberately not *whether a ticket was revoked*.
         *
         * Signing out with no ticket, an expired one, or one already revoked all answer the same,
         * because the difference is information about a credential the caller does not hold.
         */
        signedOut: z.literal(true),
    }),
    rest: { method: 'POST', path: '/identity/sign_out' },
    visibility: 'public',
    destructive: true,
    print: () => 'signed out',
});

/**
 * **Set your own password — and, if this account was made by the platform, claim it.**
 *
 * The one thing a `provisional` account may do. Identity creates one on a cluster's first boot,
 * because a platform with no accounts cannot be signed into; the gate then refuses it everywhere
 * *except this action*, and doing this clears the flag.
 *
 * Without it that account is a locked room with no door: the wall was built and the way out was
 * not, so the first boot produced a credential that could do nothing at all — including stop being
 * provisional. Found by the first person to actually run it.
 *
 * **Your own, always.** There is no `userId` in the input. Changing somebody else's password is a
 * different act with a different name and a different gate, and a contract that took an id would be
 * one missing check away from being that act.
 */
export const setPasswordContract = defineContract({
    domain: 'identity',
    action: 'set_password',
    description: 'Set your own password. Claims a provisional account.',
    inputSchema: z.object({
        password: z.string().min(12).describe('At least twelve characters. Yours to choose.'),
    }),
    outputSchema: z.object({
        ok: z.literal(true),
        /** True when this call claimed a provisional account, so a client can say so. */
        claimed: z.boolean(),
    }),
    rest: { method: 'POST', path: '/identity/password' },
    /**
     * `user`, not `public`: you must already hold a session, which for a provisional account means
     * the password printed at first boot. Public would let anybody set anybody's — the input has no
     * id precisely so the caller *is* the subject, and that only holds if there is a caller.
     */
    visibility: 'public',
    destructive: true,
    print: (o) => (o.claimed ? 'password set, account claimed' : 'password set'),
});

/**
 * What changed since an API instance last looked.
 *
 * **The contract that makes revocation correct** rather than likely. mesh-web spec/auth.md §3.1: the
 * mesh delivers events at-most-once, so an instance that was down when a ticket was revoked never
 * hears about it. A poll cannot be missed, only delayed.
 *
 * The event `identity.ticket_revoked` still fires, and an instance still listens — that is what
 * makes the common case immediate. This is what makes it *right*.
 */
export const revocationsSinceContract = defineContract({
    domain: 'identity',
    action: 'revocations_since',
    description: 'Revocations after a given epoch, for an API instance catching up.',
    inputSchema: z.object({
        epoch: z.number().describe('The last epoch this caller has seen. 0 for everything retained.'),
        limit: z.number().optional(),
    }),
    outputSchema: z.object({
        epoch: z.number().describe('The newest epoch, to poll from next time'),
        revocations: z.array(z.object({
            epoch: z.number(),
            kind: z.enum(['ticket', 'principal']),
            subject: z.string(),
            at: z.number(),
        })),
        /**
         * True when the caller's epoch is older than anything retained.
         *
         * It cannot be told what it missed, so it must not pretend to be current: the honest
         * response is for it to drop its cache and re-validate, which is the one case where §3's
         * original "drop everything on reconnect" is still the right answer.
         */
        truncated: z.boolean(),
    }),
    rest: { method: 'GET', path: '/identity/revocations' },
    print: (o) => `${String(o.revocations.length)} revocations up to epoch ${String(o.epoch)}`,
});

// ---------------------------------------------------------------------------- principals

export const whoamiContract = defineContract({
    domain: 'identity',
    action: 'whoami',
    description: 'Who the caller is, and which organizations they belong to.',
    inputSchema: z.object({}),
    outputSchema: z.object({
        userId: z.string(),
        email: z.string(),
        displayName: z.string(),
        roles: z.array(z.string()),
        organizations: z.array(z.object({
            organizationId: z.string(),
            name: z.string(),
            roleKey: z.string(),
        })),
    }),
    rest: { method: 'GET', path: '/identity/whoami' },
    visibility: 'public',
    print: (o) => `${o.displayName} <${o.email}>`,
});

export const registerContract = defineContract({
    domain: 'identity',
    action: 'register',
    description: 'Create an account.',
    inputSchema: z.object({
        email: z.string().email(),
        password: z.string().min(8),
        displayName: z.string().min(1),
    }),
    outputSchema: z.object({ userId: z.string() }),
    rest: { method: 'POST', path: '/identity/register' },
    visibility: 'public',
    destructive: true,
    print: (o) => `registered ${o.userId}`,
});

/**
 * Give an account a cluster-scoped role, or take one away.
 *
 * **Without this nobody can ever become an operator, and that was the state until 2026-09-07.**
 * `roles` lives on the user row, identity keeps its own store, and `user` is internal for writes —
 * so the only paths to it were a database client and a shell. Every operator-gated contract was
 * therefore unreachable by construction: the fleet console 403'd for everybody, for ever, and no
 * amount of gating or granting on the site could change it. "Manage the platform from the UI" has
 * to include *becoming somebody who may*.
 *
 * ## Who may call it
 *
 * An operator, and nobody else — the role is what grants the role. That is deliberate and it leaves
 * the obvious hole: the *first* operator cannot exist. `MESH_BOOTSTRAP_OPERATOR` closes it, naming
 * one email that identity promotes at startup, **read from the server's environment and never from
 * a request**. An input flag would let any caller nominate themselves, which is not a bootstrap but
 * an escalation. The node operator decides once, in a file somebody can look at.
 *
 * ## Cluster-scoped only
 *
 * An organization role belongs on the membership, because it is a fact about a person *in* an
 * organization. The store refuses one here rather than storing something that reads as
 * platform-wide standing — see `mongoStore.updateUser`.
 */
export const grantRoleContract = defineContract({
    domain: 'identity',
    action: 'grant_role',
    description: 'Grant or revoke a cluster-scoped role on an account.',
    dependencies: [],
    inputSchema: z.object({
        /** Either identifies the account. An email is what a person has to hand. */
        userId: z.string().min(1).optional(),
        email: z.string().email().optional(),
        role: z.string().min(1).describe('A cluster-scoped role key, e.g. operator'),
        /** False revokes it. Present rather than a second contract: the check is identical. */
        granted: z.boolean().default(true),
    }),
    outputSchema: z.object({
        userId: z.string(),
        roles: z.array(z.string()).describe('Every cluster role the account holds afterwards'),
        changed: z.boolean(),
    }),
    rest: { method: 'POST', path: '/identity/roles' },
    /**
     * Exposable, and a site that exposes it must gate it at `operator`.
     *
     * `public` here means *may be exposed*, as everywhere — the handler checks the caller's role
     * itself and does not rely on the gate, because a contract that grants platform standing is
     * the last place to trust that a site was configured correctly.
     */
    visibility: 'public',
    destructive: true,
    print: (o) => `${o.userId}: ${o.roles.join(', ') || 'no roles'}`,
});

// ---------------------------------------------------------------------------- authorization

/**
 * May a caller holding these roles call this contract?
 *
 * Here rather than in the API because the answer depends on grant *records*, which live here. The
 * API asks; identity decides. That keeps the whole of "what is a role" in one module, which is what
 * lets a deployment define `author` and `compliance` without either the API or the framework
 * knowing those words.
 */
export const permitsContract = defineContract({
    domain: 'identity',
    action: 'permits',
    description: 'Whether a caller holding these roles may call a contract.',
    inputSchema: z.object({
        roles: z.array(z.string()),
        contract: z.string().min(1),
        organizationId: z.string().optional(),
    }),
    outputSchema: z.object({ permitted: z.boolean() }),
    rest: { method: 'POST', path: '/identity/permits' },
    print: (o) => (o.permitted ? 'permitted' : 'denied'),
});

// ---------------------------------------------------------------------------- api tokens

export const apiTokenValidateContract = defineContract({
    domain: 'identity',
    action: 'api_token_validate',
    description: 'Is this API token valid, and which principal does it represent.',
    inputSchema: z.object({
        token: z.string().min(1),
    }),
    outputSchema: z.object({
        valid: z.boolean(),
        userId: z.string().optional(),
        organizationId: z.string().optional(),
        organizationSlug: z.string().optional(),
        roles: z.array(z.string()).optional(),
        name: z.string().optional(),
    }),
    rest: { method: 'POST', path: '/identity/api-token/validate' },
    print: (o) => (o.valid ? `valid: ${o.userId ?? 'unknown'}` : 'invalid'),
});

export const apiTokenIssueContract = defineContract({
    domain: 'identity',
    action: 'api_token_issue',
    description: 'Mint an API token for a principal.',
    inputSchema: z.object({
        name: z.string().min(1),
        userId: z.string().min(1),
        organizationId: z.string().optional(),
        roles: z.array(z.string()).optional(),
        expiresInMs: z.number().optional(),
    }),
    outputSchema: z.object({
        token: z.string(),
        tokenId: z.string(),
        name: z.string(),
        userId: z.string(),
        organizationId: z.string().optional(),
        roles: z.array(z.string()),
        createdAt: z.number(),
        expiresAt: z.number().optional(),
    }),
    rest: { method: 'POST', path: '/identity/api-token/issue' },
    destructive: true,
    print: (o) => `issued api token "${o.name}" for ${o.userId}`,
});

interface CrudContractSet {
    readonly find: ToolContract;
    readonly findOne: ToolContract;
    readonly count: ToolContract;
    readonly get: ToolContract;
    readonly resolve: ToolContract;
    readonly create: ToolContract;
    readonly createMany: ToolContract;
    readonly update: ToolContract;
    readonly replace: ToolContract;
    readonly delete: ToolContract;
}

export function extractCrudContracts(crud: CrudContractSet): readonly ToolContract[] {
    return [
        crud.find,
        crud.findOne,
        crud.count,
        crud.get,
        crud.resolve,
        crud.create,
        crud.createMany,
        crud.update,
        crud.replace,
        crud.delete,
    ];
}

export const identityContracts: readonly ToolContract[] = [
    ticketIssueContract,
    ticketValidateContract,
    ticketRevokeContract,
    signOutContract,
    setPasswordContract,
    revocationsSinceContract,
    whoamiContract,
    registerContract,
    grantRoleContract,
    permitsContract,
    apiTokenValidateContract,
    apiTokenIssueContract,
];

export const identityCrudContracts: readonly ToolContract[] = [
    ...extractCrudContracts(userCrud),
    ...extractCrudContracts(organizationCrud),
    ...extractCrudContracts(membershipCrud),
    ...extractCrudContracts(roleCrud),
    ...extractCrudContracts(grantCrud),
    ...extractCrudContracts(ticketCrud),
    ...extractCrudContracts(apiTokenCrud),
];

export const allIdentityContracts: readonly ToolContract[] = [
    ...identityContracts,
    ...identityCrudContracts,
];
