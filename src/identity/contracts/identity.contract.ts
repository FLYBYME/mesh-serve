/**
 * What identity answers over the mesh.
 *
 * **Every action is `internal` unless this file says otherwise, and that is mesh's default rather
 * than a choice made here.** Identity is what every deployment authenticates through:
 * `ticket_validate` on the public internet would let anyone test tickets against it.
 *
 * Three are `public`, because each is a call that cannot require having already made it — signing
 * in, signing out, and asking who you are. Even then it is the *site's* exposure that decides
 * whether they are reachable, not this file (`spec/serving.md` §5).
 */

import { defineContract, defineCrud, type ToolContract, z } from '@flybyme/mesh';

import { MembershipSchema, OrganizationSchema, UserSchema } from '../schema/principals.js';
import { TicketSchema, ValidationSchema } from '../schema/tickets.js';

// ---------------------------------------------------------------------------- collections

/**
 * Accounts. Global: a user is not owned by an organization, it joins one through a membership.
 *
 * **Sealed, every action, and it is not a preference.** The row carries `passwordHash` and nothing
 * subtracts a field from a read, so the only way to keep it in is to let nothing out. That is
 * `spec/questions.md` **A1**, it is the reason nothing here can turn a user id into a name, and it
 * is the first thing to change when mesh 2 → 3 lands.
 */
export const userCrud = defineCrud('user', UserSchema, {
    pluralPath: 'users',
    unique: [{ fields: 'email', scope: 'global' }],
    dependencies: [],
});

export type StoredUser = z.infer<typeof userCrud.outputSchema>;

/** Organizations. Global, because an organization is the tenant boundary and cannot sit inside one. */
export const organizationCrud = defineCrud('organization', OrganizationSchema, {
    pluralPath: 'organizations',
    unique: [{ fields: 'slug', scope: 'global' }],
    /**
     * `create` is published and the rest of the writes are not, which is the decision written down.
     *
     * Making an organization is how a signed-in account gets somewhere to own things, so refusing it
     * means only an operator can ever create a tenant. Renaming or deleting one affects everybody
     * inside it and wants a contract that says what happens to them — **E1**, the handover that has
     * a store method and no contract.
     */
    visibility: { find: 'public', get: 'public', count: 'public', create: 'public' },
    dependencies: [],
});

export type StoredOrganization = z.infer<typeof organizationCrud.outputSchema>;

/**
 * An account's place in one organization.
 *
 * ## **`scopedBy` cannot be used here, and finding out why cost a boot**
 *
 * The obvious declaration is `scopedBy: 'organizationId'`, and `spec/identity.md` assumed it. It
 * cannot work: **the scope is resolved *from* this collection.** A request arrives, the gate reads
 * the caller's memberships to decide which organization they are in, and `scopedBy` refuses that
 * read because no scope has been resolved yet. The node died on its first boot with
 *
 *     Scoped collection "membership" requires a resolved "organizationId" scope
 *
 * raised by bootstrap, which has no caller at all. Every path into this collection hits it:
 * bootstrap, the gate, and `identity.whoami`.
 *
 * **So the narrowing is a hook rather than a declaration** — `narrowMembership` in
 * `../identity.service.js`, which confines a read to the caller's own rows. That is a stricter
 * filter than the scope would have been, not a looser one: `scopedBy` would have let a member read
 * every membership of their organization, and this lets them read their own.
 *
 * `unique` is global for the same reason — there is no scope to be unique within — and the key is
 * the pair, which is the rule `scope: 'scoped'` was expressing.
 */
export const membershipCrud = defineCrud('membership', MembershipSchema, {
    pluralPath: 'memberships',
    unique: [{ fields: ['userId', 'organizationId'], scope: 'global' }],
    visibility: { find: 'public', get: 'public', count: 'public' },
    dependencies: [],
});

export type StoredMembership = z.infer<typeof membershipCrud.outputSchema>;

/**
 * Tickets. Every action internal, permanently.
 *
 * There is no version of *expose the credential table* that is right, and unlike `user` this one is
 * not waiting on a feature.
 */
export const ticketCrud = defineCrud('ticket', TicketSchema, {
    pluralPath: 'tickets',
    unique: [{ fields: 'token', scope: 'global' }],
    dependencies: [],
});

export type StoredTicket = z.infer<typeof ticketCrud.outputSchema>;

// ---------------------------------------------------------------------------- signing in

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
        /** So a client can say *claim this account* instead of letting the next call refuse. */
        provisional: z.boolean(),
    }),
    rest: { method: 'POST', path: '/identity/ticket' },
    /** Public, because signing in is the one call that cannot require being signed in. */
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

/**
 * End **this** session, and nothing else.
 *
 * It takes the token rather than nothing, and the reason is worth keeping: what crosses the broker
 * is *who* the caller is, never the credential they arrived on — an application never handles one.
 * Making it work with no argument would mean putting a live credential in `meta`, where every
 * handler on the mesh would receive it.
 *
 * **Presenting a token proves you hold it, and revoking a ticket you hold is strictly less powerful
 * than using it.** The dangerous parameter is `userId`, which acts on a person rather than on a
 * credential, and it is absent here.
 */
export const signOutContract = defineContract({
    domain: 'identity',
    action: 'sign_out',
    description: 'End the calling session.',
    inputSchema: z.object({
        /** Yours by definition: you had to hold it to send it. */
        token: z.string().min(1),
    }),
    outputSchema: z.object({
        /**
         * Always true, and deliberately not *whether a ticket was revoked*. Signing out with no
         * ticket, an expired one, or one already revoked all answer the same, because the difference
         * is information about a credential the caller does not hold.
         */
        signedOut: z.literal(true),
    }),
    rest: { method: 'POST', path: '/identity/sign_out' },
    visibility: 'public',
    destructive: true,
    print: () => 'signed out',
});

// ---------------------------------------------------------------------------- your own account

/**
 * **Set your own password — and, if the platform made this account, claim it.**
 *
 * The one thing a provisional account may do. **There is no `userId` in the input**: the caller *is*
 * the subject, and a contract that took an id would be one missing check away from being a different
 * and far more dangerous act.
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
    /** `public` at the contract; the gate still requires a caller. A site exposes it at `user`. */
    visibility: 'public',
    destructive: true,
    print: (o) => (o.claimed ? 'password set, account claimed' : 'password set'),
});

/**
 * Who am I, and what may I do.
 *
 * **This is what `mesh-serve login` prints** (`spec/cli.md` §2), and the shape is from
 * `spec/identity.md` §7: one list, per account, with scope as a column rather than as a separate
 * question. An account in three organizations has three different answers and they belong in one
 * response, because the alternative is a caller making three calls to find out what to try.
 */
export const whoamiContract = defineContract({
    domain: 'identity',
    action: 'whoami',
    description: 'The calling account, its organizations, and what it may call.',
    inputSchema: z.object({}),
    outputSchema: z.object({
        userId: z.string(),
        email: z.string(),
        displayName: z.string(),
        provisional: z.boolean(),
        organizations: z.array(z.object({
            organizationId: z.string(),
            slug: z.string(),
            name: z.string(),
            roleKey: z.string(),
        })),
        /**
         * What this account may call, and where.
         *
         * `scope` is `undefined` for a permission held everywhere, and an organization id otherwise.
         * A flat list with a column, not a map keyed by organization: the caller wants to know what
         * to try, and grouping makes them assemble that themselves.
         */
        permissions: z.array(z.object({
            permission: z.string(),
            scope: z.string().optional(),
        })),
    }),
    rest: { method: 'GET', path: '/identity/whoami' },
    visibility: 'public',
    print: (o) => `${o.email} (${String(o.organizations.length)} org)`,
});

export const allIdentityContracts: readonly ToolContract<z.ZodTypeAny, z.ZodTypeAny>[] = [
    ticketIssueContract,
    ticketValidateContract,
    signOutContract,
    setPasswordContract,
    whoamiContract,
];

export const identityCrudCollections = [
    userCrud,
    organizationCrud,
    membershipCrud,
    ticketCrud,
] as const;
