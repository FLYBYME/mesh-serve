/**
 * The `identity` ServiceModule.
 *
 * mesh-web spec/service-modules.md §2: **no listener.** It answers mesh calls and emits events, and
 * mesh-api is effectively its only caller. There is no port here and there must not be one — an
 * identity module that bound a port would be a second front door to the thing everything else
 * authenticates through.
 *
 * Duck-typed rather than `extends ServiceModule`, for the same reason mesh-api's module is:
 * `registerModule` takes the interface and never checks `instanceof`, so implementing the members it
 * calls keeps this a plain object with no inherited lifecycle to reason about.
 */

import type { IServiceBroker, IServiceContext, IServiceModule, ToolContract, z } from '@flybyme/mesh';
import { createHash } from 'node:crypto';

import { identityContracts } from './contracts/identity.contract.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from './methods/password.js';
import { BUILTIN_ROLES, permits, PUBLIC_ROLE } from './schema/roles.js';
import { DEFAULT_TICKET_LIFETIME_MS, isLive, mintToken, type Validation } from './schema/tickets.js';
import { memoryStore, type IdentityStore } from './store.js';

export interface IdentityModuleOptions {
    readonly store?: IdentityStore;
    /** How long an issued ticket lives. A correctness parameter now — see auth §3.1. */
    readonly ticketLifetimeMs?: number;
    /** How many revocations one poll may return. */
    readonly pollLimit?: number;
    readonly now?: () => number;
    readonly onError?: (error: unknown, context: { readonly action: string }) => void;
}

export interface IdentityModule extends IServiceModule {
    readonly store: IdentityStore;
}

/** `identity.ticket_revoked`, emitted alongside the epoch. Latency, not correctness — auth §3.1. */
export const TICKET_REVOKED_EVENT = 'identity.ticket_revoked';

export function createIdentityModule(options: IdentityModuleOptions = {}): IdentityModule {
    const store = options.store ?? memoryStore();
    const now = options.now ?? Date.now;
    const lifetime = options.ticketLifetimeMs ?? DEFAULT_TICKET_LIFETIME_MS;
    const pollLimit = options.pollLimit ?? 500;
    const onError = options.onError ?? (() => {});

    let broker: IServiceBroker | undefined;

    const contracts = identityContracts as unknown as ToolContract<z.ZodTypeAny, z.ZodTypeAny>[];

    /**
     * Record a revocation and tell anyone listening.
     *
     * The epoch is what makes it correct; the event is what makes it fast. Emitted *after* the
     * append, so a listener that immediately polls cannot be told about something not yet recorded.
     */
    const revoke = async (
        kind: 'ticket' | 'principal',
        subject: string,
        reason: string | undefined,
    ): Promise<number> => {
        const epoch = await store.appendRevocation({
            kind,
            subject,
            at: now(),
            ...(reason === undefined ? {} : { reason }),
        });

        try {
            (broker as unknown as { emit?(e: string, p: unknown): void } | undefined)
                ?.emit?.(TICKET_REVOKED_EVENT, { kind, subject, epoch, at: now() });
        } catch (error) {
            // A failed emit costs latency, never correctness — the poller will find it. Swallowing
            // it here is safe *because* of that, and would not be otherwise.
            onError(error, { action: 'revoke.emit' });
        }

        return epoch;
    };

    const validate = async (token: string): Promise<Validation> => {
        const { newest } = await store.epochRange();
        const ticket = await store.getTicket(token);

        if (ticket === undefined || !isLive(ticket, now())) {
            return { valid: false, epoch: newest };
        }

        const user = await store.getUser(ticket.userId);
        // A suspended principal fails regardless of a live ticket — the ticket says what was true
        // when it was issued, and this is the thing that outranks it.
        if (user === undefined || user.value.suspendedAt !== undefined) {
            return { valid: false, epoch: newest };
        }

        return {
            valid: true,
            userId: ticket.userId,
            // From the user rather than the ticket: roles granted since it was issued should apply,
            // and roles removed since should stop applying. A ticket is identity, not authority.
            roles: [PUBLIC_ROLE, 'authenticated', ...user.value.roles],
            expiresAt: ticket.expiresAt,
            epoch: newest,
        };
    };

    return {
        domain: 'identity',
        store,

        getContracts: () => contracts,
        isCrud: () => false,
        getEventHandlers: () => new Map(),
        async beforeCrud(_d, _a, input) { return input; },
        async afterCrud(_d, _a, output) { return output; },

        async onStart(started: IServiceBroker): Promise<void> {
            broker = started;

            // A deployment with no `public` role cannot answer an anonymous request at all, so the
            // builtins are ensured at start rather than left to a migration someone forgets.
            for (const role of BUILTIN_ROLES) await store.upsertRole(role);

            started.logger.info(`[identity] ready — ${String((await store.listRoles()).length)} roles`);
        },

        async execute(domain: string, action: string, input: unknown, _ctx: IServiceContext): Promise<unknown> {
            const key = `${domain}.${action}`;

            switch (key) {
                case 'identity.register': {
                    const { email, password, displayName } = input as
                        { email: string; password: string; displayName: string };

                    const existing = await store.findUserByEmail(email);
                    if (existing !== undefined) {
                        // Deliberately the same message a caller would get for a weak password:
                        // "that address is taken" is an account-enumeration oracle.
                        throw new Error('Could not create that account.');
                    }

                    const created = await store.createUser({
                        email,
                        displayName,
                        passwordHash: await hashPassword(password),
                        roles: [],
                    });
                    return { userId: created.id };
                }

                case 'identity.ticket_issue': {
                    const { email, password, via } = input as { email: string; password: string; via?: string };
                    const found = await store.findUserByEmail(email);

                    // Verify against a dummy hash when there is no account, so a missing account and
                    // a wrong password take the same time. Skipping the work is a timing oracle for
                    // which addresses have accounts.
                    const ok = await verifyPassword(password, found?.value.passwordHash ?? DUMMY_HASH);

                    if (found === undefined || !ok || found.value.suspendedAt !== undefined) {
                        throw new Error('Those credentials are not valid.');
                    }

                    const issued = now();
                    const ticket = {
                        token: mintToken(),
                        userId: found.id,
                        roles: found.value.roles,
                        issuedAt: issued,
                        expiresAt: issued + lifetime,
                        via: via ?? 'password',
                    };

                    await store.createTicket(ticket);
                    return { token: ticket.token, userId: ticket.userId, expiresAt: ticket.expiresAt };
                }

                case 'identity.ticket_validate':
                    return validate((input as { ticket: string }).ticket);

                case 'identity.ticket_revoke': {
                    const { token, userId, reason } = input as
                        { token?: string; userId?: string; reason?: string };

                    if (token !== undefined) {
                        await store.markRevoked(token, now(), reason);
                        return { revoked: 1, epoch: await revoke('ticket', token, reason) };
                    }

                    if (userId !== undefined) {
                        const live = await store.liveTicketsOf(userId);
                        for (const ticket of live) await store.markRevoked(ticket.token, now(), reason);
                        // One revocation row for the principal rather than one per ticket: a poller
                        // that drops everything for this user is correct and cheaper, and a ticket
                        // issued a moment later is covered by the same row.
                        return { revoked: live.length, epoch: await revoke('principal', userId, reason) };
                    }

                    throw new Error('ticket_revoke needs a token or a userId.');
                }

                case 'identity.revocations_since': {
                    const { epoch, limit } = input as { epoch: number; limit?: number };
                    const range = await store.epochRange();

                    // The caller is further behind than anything retained. It cannot be told what it
                    // missed, so it must not believe it is current: `truncated` tells it to drop its
                    // cache and re-validate, which is the one case §3's original advice still fits.
                    const truncated = range.oldest > 0 && epoch < range.oldest - 1;

                    const revocations = await store.revocationsSince(epoch, limit ?? pollLimit);
                    return {
                        epoch: range.newest,
                        revocations: revocations.map((r) => ({
                            epoch: r.epoch, kind: r.kind, subject: r.subject, at: r.at,
                        })),
                        truncated,
                    };
                }

                case 'identity.whoami': {
                    const userId = (_ctx.meta as { user?: { id?: string } } | undefined)?.user?.id;
                    if (userId === undefined) throw new Error('Not signed in.');

                    const user = await store.getUser(userId);
                    if (user === undefined) throw new Error('Not signed in.');

                    const memberships = await store.membershipsOf(userId);
                    const organizations = [];
                    for (const membership of memberships) {
                        const org = await store.getOrganization(membership.organizationId);
                        if (org === undefined) continue;
                        organizations.push({
                            organizationId: membership.organizationId,
                            name: org.value.name,
                            roleKey: membership.roleKey,
                        });
                    }

                    return {
                        userId,
                        email: user.value.email,
                        displayName: user.value.displayName,
                        roles: user.value.roles,
                        organizations,
                    };
                }

                case 'identity.permits': {
                    const { roles, contract } = input as { roles: string[]; contract: string };
                    return { permitted: permits(roles, await store.listGrants(), contract) };
                }

                default:
                    throw new Error(`identity has no action "${action}"`);
            }
        },
    };
}

/** A stored API token is hashed: unlike a ticket, nothing ever needs to read it back. */
export const hashApiToken = (token: string): string =>
    createHash('sha256').update(token).digest('hex');
