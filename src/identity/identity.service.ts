/**
 * The `identity` service.
 *
 * **No listener, and there must not be one.** It answers mesh calls; the API projection is its only
 * caller from outside. An identity service that bound a port would be a second front door to the
 * thing everything else authenticates through.
 *
 * Every read and write here goes through `ctx.call` into the collections mounted below, which is the
 * whole reason `mountCrud` exists. There is no store abstraction and no direct database handle: the
 * previous implementation had both, at 3,343 lines, and the store was a second query language for
 * data mesh already knew how to query.
 */

import {
    ClientError, ServiceModule, type IServiceBroker, type IServiceContext,
    type ServiceActionHandler, type ToolContract, type z,
} from '@flybyme/mesh';

import { DUMMY_HASH, hashPassword, verifyPassword } from './methods/password.js';
import {
    allIdentityContracts, membershipCrud, organizationCrud, setPasswordContract, signOutContract,
    ticketCrud, ticketIssueContract, ticketValidateContract, userCrud, whoamiContract,
    type StoredUser,
} from './contracts/identity.contract.js';
import { DEFAULT_TICKET_LIFETIME_MS, isLive, mintToken } from './schema/tickets.js';

export interface IdentityServiceOptions {
    /** How long an issued ticket lives. A correctness parameter, not a preference. */
    readonly ticketLifetimeMs?: number;
    /** Injected so a test can run without waiting twelve hours or stubbing the clock globally. */
    readonly now?: () => number;
    /** Where the first-boot banner goes. Injected so a test can read it instead of the terminal. */
    readonly announce?: (banner: string) => void;
}

/** The account the platform creates when there are none. Not a real address, deliberately. */
export const FIRST_BOOT_EMAIL = 'operator@node.invalid';

export class IdentityService extends ServiceModule {
    public readonly domain = 'identity';

    private readonly lifetime: number;
    private readonly now: () => number;
    private readonly announce: (banner: string) => void;

    constructor(options: IdentityServiceOptions = {}) {
        super();

        this.lifetime = options.ticketLifetimeMs ?? DEFAULT_TICKET_LIFETIME_MS;
        this.now = options.now ?? Date.now;
        this.announce = options.announce ?? ((banner) => process.stdout.write(banner));

        /**
         * **The collections are not mounted here**, and that is mesh's rule rather than a choice.
         *
         * A CRUD hook is dispatched to the module whose `domain` equals the collection's, so a
         * service called `identity` mounting `membership` can never be given a hook for it — the
         * hook registers, is never asked for, and a narrowing that looks present does nothing. See
         * `../collection.js`, which is where that is written down and where the collections live.
         */
        this.mountTool(ticketIssueContract, this.issueTicket);
        this.mountTool(ticketValidateContract, this.validateTicket);
        this.mountTool(signOutContract, this.signOut);
        this.mountTool(setPasswordContract, this.setPassword);
        this.mountTool(whoamiContract, this.whoami);
    }

    /**
     * **First boot: a cluster with no accounts cannot be signed into.**
     *
     * So one is created, its password is printed once, and it is marked `provisional` — refused
     * everywhere except `identity.set_password`, which clears the flag.
     *
     * Idempotent by construction: it counts first and does nothing if any account exists. A restart
     * must not mint a second operator, and a node that crashed halfway through its first boot must
     * be able to try again.
     */
    public async onStart(broker: IServiceBroker): Promise<void> {
        const existing = await broker.call('user.count', {});
        if (existing > 0) return;

        const password = mintToken();
        const user = await broker.call('user.create', {
            email: FIRST_BOOT_EMAIL,
            displayName: 'Operator',
            passwordHash: await hashPassword(password),
            provisional: true,
            roles: [],
        });

        this.announce(firstBootBanner(FIRST_BOOT_EMAIL, password, user.id));
    }

    /**
     * Sign in.
     *
     * **A missing account and a wrong password take the same time and give the same answer.** The
     * verify runs against a dummy hash when there is no such email, because skipping the work is a
     * timing oracle for which addresses have accounts, and the message names neither field for the
     * same reason.
     */
    private readonly issueTicket: ServiceHandler<typeof ticketIssueContract> = async (input, ctx) => {
        const found = await ctx.call('user.find', { query: { email: input.email }, limit: 1 });
        const user = found[0];

        const ok = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);
        if (!ok || user === undefined) throw new ClientError('Email or password is wrong.');

        if (user.suspendedAt !== undefined) {
            throw new ClientError('This account is suspended.');
        }

        const issuedAt = this.now();
        const expiresAt = issuedAt + this.lifetime;

        const ticket = await ctx.call('ticket.create', {
            token: mintToken(),
            userId: user.id,
            roles: user.roles,
            issuedAt,
            expiresAt,
            via: input.via ?? 'password',
        });

        return {
            token: ticket.token,
            userId: user.id,
            expiresAt,
            provisional: user.provisional === true,
        };
    };

    /**
     * Whose ticket is this.
     *
     * **An invalid ticket answers `{ valid: false }` rather than throwing.** The caller is asking a
     * question, and *no* is an answer to it — a thrown error here would make every anonymous request
     * an exception on the serving path.
     */
    private readonly validateTicket: ServiceHandler<typeof ticketValidateContract> = async (input, ctx) => {
        const found = await ctx.call('ticket.find', { query: { token: input.ticket }, limit: 1 });
        const ticket = found[0];
        if (ticket === undefined || !isLive(ticket, this.now())) return { valid: false };

        const user = await ctx.call('user.resolve', { id: ticket.userId });
        if (user === undefined || user.suspendedAt !== undefined) return { valid: false };

        return {
            valid: true,
            userId: ticket.userId,
            roles: ticket.roles,
            expiresAt: ticket.expiresAt,
            provisional: user.provisional === true,
        };
    };

    /**
     * End this session.
     *
     * Answers the same whatever it finds, because the difference between *revoked it* and *there was
     * nothing to revoke* is information about a credential the caller does not hold.
     */
    private readonly signOut: ServiceHandler<typeof signOutContract> = async (input, ctx) => {
        const found = await ctx.call('ticket.find', { query: { token: input.token }, limit: 1 });
        const ticket = found[0];

        if (ticket !== undefined && ticket.revokedAt === undefined) {
            await ctx.call('ticket.update', {
                id: ticket.id,
                revokedAt: this.now(),
                revokedReason: 'signed out',
            });
        }

        return { signedOut: true } as const;
    };

    /**
     * Set your own password, and claim the account if the platform made it.
     *
     * **Every other live ticket dies**, including the caller's own. A credential that outlives the
     * reason it was changed is not a credential that was changed — and the previous implementation
     * recorded the revocation without marking the tickets, so a password changed because it was
     * believed compromised left every old session working until it expired days later. Nothing
     * failed and nothing said so.
     */
    private readonly setPassword: ServiceHandler<typeof setPasswordContract> = async (input, ctx) => {
        const caller = callerOf(ctx);

        const user = await ctx.call('user.get', { id: caller });
        const claimed = user.provisional === true;

        await ctx.call('user.update', {
            id: caller,
            passwordHash: await hashPassword(input.password),
            provisional: false,
        });

        const live = await ctx.call('ticket.find', { query: { userId: caller }, limit: 1000 });
        const now = this.now();
        for (const ticket of live) {
            if (ticket.revokedAt !== undefined) continue;
            await ctx.call('ticket.update', { id: ticket.id, revokedAt: now, revokedReason: 'password changed' });
        }

        return { ok: true, claimed } as const;
    };

    /**
     * Who am I, and what may I do.
     *
     * The permission list is `spec/identity.md` §7's shape and **not yet its content**: until the
     * contract rename (**C1**) there is no hierarchy for a pattern to match, so what comes back is
     * the roles this account actually holds, with scope as a column. The shape is the part that has
     * to be right now, because it is what a client is written against.
     */
    private readonly whoami: ServiceHandler<typeof whoamiContract> = async (_input, ctx) => {
        const caller = callerOf(ctx);
        const user = await ctx.call('user.get', { id: caller });

        /**
         * The caller's own memberships.
         *
         * The `userId` here is redundant — `narrowMembership` overwrites it with the same value
         * from `meta` — and it stays because the query should say what it means without the reader
         * having to know a hook exists. **The hook is the enforcement; this is the intent.**
         */
        const memberships = await ctx.call('membership.find', {
            query: { userId: caller },
            limit: 100,
        });

        const organizations = [];
        for (const membership of memberships) {
            const org = await ctx.call('organization.resolve', { id: membership.organizationId });
            if (org === undefined) continue;
            organizations.push({
                organizationId: org.id,
                slug: org.slug,
                name: org.name,
                roleKey: membership.roleKey,
            });
        }

        const permissions = [
            ...user.roles.map((permission) => ({ permission })),
            ...memberships.map((m) => ({ permission: m.roleKey, scope: m.organizationId })),
        ];

        return {
            userId: user.id,
            email: user.email,
            displayName: user.displayName,
            provisional: user.provisional === true,
            organizations,
            permissions,
        };
    };
}

/**
 * The caller's account id, or a refusal.
 *
 * `ctx.meta.user.id` is set by the gate from a validated ticket and by nothing else. Reading it
 * through `IMeshMeta` rather than casting is the point: mesh declares this shape, and the three
 * places that re-declared it inline are the defect `spec/README.md` rule 2 names.
 */
function callerOf(ctx: IServiceContext): string {
    const id = ctx.meta?.user?.id;
    if (typeof id !== 'string' || id === '') {
        throw new ClientError('This needs a signed-in caller.');
    }
    return id;
}

/**
 * A handler for one contract, typed **from the contract** rather than restated beside it.
 *
 * `mountTool` already constrains this. Naming it is what lets the handler be a class property with
 * its types attached, so a wrong return shape fails at the property and not forty lines away at the
 * mount — and so nobody is tempted to write the input type out by hand and let it drift.
 */
type ServiceHandler<C extends ToolContract<z.ZodTypeAny, z.ZodTypeAny>> =
    ServiceActionHandler<z.infer<C['inputSchema']>, z.infer<C['outputSchema']>>;

/**
 * Printed once, and not recoverable.
 *
 * It says what the credential can do, what to run next, and that it will not be shown again. A
 * first-boot message that leaves somebody at a prompt with a password and no verb has not done its
 * job. How it survives a startup that logs one line per registered tool is **E6**.
 */
function firstBootBanner(email: string, password: string, userId: string): string {
    const rule = '─'.repeat(72);
    return [
        '',
        rule,
        '  FIRST BOOT — no accounts existed, so one was created.',
        '',
        `    email     ${email}`,
        `    password  ${password}`,
        '',
        '  This is shown once and is not recoverable. It can do nothing except set its own',
        '  password — every other call is refused until it does.',
        '',
        '    npx mesh-serve login',
        '',
        `  (${userId})`,
        rule,
        '',
    ].join('\n');
}

export { allIdentityContracts, type StoredUser };
