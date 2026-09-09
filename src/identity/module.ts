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

import { MeshError, type IServiceBroker, type IServiceContext, type IServiceModule, type ToolContract, type z } from '@flybyme/mesh';
import { createHash, randomBytes } from 'node:crypto';

import {
    allIdentityContracts,
    apiTokenIssueContract,
    apiTokenValidateContract,
} from './contracts/identity.contract.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from './methods/password.js';
import { type ApiToken } from './schema/principals.js';
import { BUILTIN_ROLES, permits, PUBLIC_ROLE, type Role } from './schema/roles.js';
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

    const CRUD_DOMAINS = new Set([
        'user',
        'organization',
        'membership',
        'role',
        'grant',
        'ticket',
        'apiToken',
    ]);

    const contracts: ToolContract[] = [...allIdentityContracts];

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
            // From the user, like the roles above: clearing the flag takes effect on the next call
            // rather than the next sign-in.
            ...(user.value.provisional === true ? { provisional: true } : {}),
            epoch: newest,
        };
    };

    return {
        domain: 'identity',
        store,

        getContracts: () => contracts,
        isCrud: (domain: string, _action: string) => CRUD_DOMAINS.has(domain),
        getEventHandlers: () => new Map(),
        async beforeCrud(_d, _a, input) { return input; },
        async afterCrud(_d, _a, output) { return output; },

        async onStart(started: IServiceBroker): Promise<void> {
            broker = started;

            // A deployment with no `public` role cannot answer an anonymous request at all, so the
            // builtins are ensured at start rather than left to a migration someone forgets.
            for (const role of BUILTIN_ROLES) await store.upsertRole(role);

            /**
             * **The first operator, named by the machine rather than by a request.**
             *
             * `identity.grant_role` requires the operator role, which leaves nobody able to make
             * the first one — every operator-gated contract unreachable for ever, which is exactly
             * where this deployment sat until now. An input flag would let any caller nominate
             * themselves, so the decision is the node operator's, made once, in a file: read from
             * the environment, never from a call.
             *
             * Idempotent and quiet when there is nothing to do, because it runs on every boot. It
             * does not create the account — the address has to have registered — since a node
             * silently minting a privileged account nobody asked for is worse than a clear failure.
             */
            const bootstrapOperator = process.env['MESH_BOOTSTRAP_OPERATOR'];
            if (bootstrapOperator !== undefined && bootstrapOperator.trim() !== '') {
                /**
                 * **Caught, because a convenience must not be able to take the node down.**
                 *
                 * The first version was not, and it did: `operator` had no `role` row, `updateUser`
                 * correctly refused a role key it could not find, and the throw travelled out of
                 * `onStart` and killed the process. systemd restarted it, into the same crash, for
                 * ever — so a line in an environment file turned the whole platform off.
                 *
                 * The missing row is fixed (`BUILTIN_ROLES`), and that is the smaller half. The
                 * lesson is the boundary: this promotes an account as a favour at boot, and
                 * *nothing* it can discover about the database is worth refusing to serve over. A
                 * node that starts without an operator is inconvenient; a node that will not start
                 * is an outage.
                 */
                try {
                    const account = await store.findUserByEmail(bootstrapOperator.trim());
                    if (account === undefined) {
                        started.logger.warn(
                            `[identity] MESH_BOOTSTRAP_OPERATOR names ${bootstrapOperator}, which `
                            + `has no account. Register it and restart, or the fleet has no operator.`,
                        );
                    } else if (!account.value.roles.includes('operator')) {
                        await store.updateUser(account.id, {
                            roles: [...new Set([...account.value.roles, 'operator'])],
                        });
                        started.logger.warn(
                            `[identity] ${account.value.email} is now a platform operator`,
                        );
                    }
                } catch (error) {
                    started.logger.error(
                        `[identity] could not promote ${bootstrapOperator} to operator: `
                        + `${error instanceof Error ? error.message : String(error)}. `
                        + `The node is serving; the fleet console will refuse until this is fixed.`,
                    );
                }
            }

            const organizationModule: IServiceModule = {
                domain: 'organization',
                getContracts: () => [],
                isCrud: (_d: string, _a: string) => true,
                getEventHandlers: () => new Map(),
                async execute(domain: string, action: string): Promise<unknown> {
                    throw new Error(`Engine Error: CRUD action "${action}" for domain "${domain}" was not intercepted.`);
                },
                async beforeCrud(domain: string, action: string, input: unknown, serviceCtx: IServiceContext) {
                    if (domain !== 'organization') return input;

                    const meta = isRecord(serviceCtx.meta) ? serviceCtx.meta : undefined;
                    let userId: string | undefined;
                    if (meta) {
                        const user = meta['user'];
                        const directUserId = meta['userId'];
                        if (isRecord(user) && typeof user['id'] === 'string' && user['id'].length > 0) {
                            userId = user['id'];
                        } else if (typeof directUserId === 'string' && directUserId.length > 0) {
                            userId = directUserId;
                        }
                    }

                    if (meta && ('user' in meta || meta['unauthenticated'] === true) && !userId) {
                        throw new MeshError({
                            code: 'UNAUTHORIZED',
                            status: 401,
                            message: 'Authentication required to access organizations.',
                        });
                    }

                    if (!userId) {
                        return input;
                    }

                    const memberships = await store.membershipsOf(userId);
                    const allowedOrgIds = memberships.map((m) => m.organizationId);

                    if (action === 'get') {
                        const params: Record<string, unknown> = isRecord(input) ? { ...input } : {};
                        const id = typeof params['id'] === 'string' ? params['id'] : '';
                        if (!allowedOrgIds.includes(id)) {
                            throw new MeshError({
                                code: 'NOT_FOUND',
                                status: 404,
                                message: `organization not found: ${id}`,
                            });
                        }
                        return params;
                    }

                    if (action === 'resolve') {
                        const params: Record<string, unknown> = isRecord(input) ? { ...input } : {};
                        const id = typeof params['id'] === 'string' ? params['id'] : '';
                        if (!allowedOrgIds.includes(id)) {
                            return { ...params, id: '000000000000000000000000' };
                        }
                        return params;
                    }

                    if (action === 'find' || action === 'find_one' || action === 'count') {
                        const params: Record<string, unknown> = isRecord(input) ? { ...input } : {};
                        const query: Record<string, unknown> = isRecord(params['query']) ? { ...params['query'] } : {};

                        if ('id' in query && query['id'] !== undefined) {
                            const requestedId = query['id'];
                            if (typeof requestedId === 'string') {
                                query['id'] = allowedOrgIds.includes(requestedId) ? requestedId : { $in: [] };
                            } else if (isRecord(requestedId)) {
                                const inVal = requestedId['$in'];
                                const eqVal = requestedId['$eq'];
                                if (Array.isArray(inVal)) {
                                    query['id'] = {
                                        $in: inVal.filter((id): id is string => typeof id === 'string' && allowedOrgIds.includes(id)),
                                    };
                                } else if (typeof eqVal === 'string') {
                                    query['id'] = allowedOrgIds.includes(eqVal) ? requestedId : { $in: [] };
                                } else {
                                    query['id'] = { $in: allowedOrgIds };
                                }
                            } else {
                                query['id'] = { $in: allowedOrgIds };
                            }
                        } else {
                            query['id'] = { $in: allowedOrgIds };
                        }

                        return { ...params, query };
                    }

                    if (action === 'create') {
                        /**
                         * **The owner is the caller, whatever the input said.**
                         *
                         * Overwritten rather than filled in when absent: a caller who may create an
                         * organization must not be able to create one owned by somebody else, and
                         * "only when absent" makes that a matter of what the client chose to send.
                         *
                         * `ownerId` is required by `OrganizationSchema` and stays required —
                         * surfdns#29 is answered by the field existing, so an organization with no
                         * owner must be unconstructible. `defineCrud` derives its create input from
                         * the same schema and has no way to make one field optional there, so a
                         * caller sends a value and this replaces it. The tidier shape is a tool that
                         * takes name and slug alone, the way `cdn.site_edit` exists because
                         * `defineCrud` could not omit a field from an update. Recorded in
                         * spec/roadmap.md.
                         */
                        const params: Record<string, unknown> = isRecord(input) ? { ...input } : {};
                        return { ...params, ownerId: userId };
                    }

                    if (action === 'delete' || action === 'update' || action === 'replace') {
                        const params: Record<string, unknown> = isRecord(input) ? { ...input } : {};
                        const id = typeof params['id'] === 'string' ? params['id'] : '';
                        if (!allowedOrgIds.includes(id)) {
                            throw new MeshError({
                                code: 'NOT_FOUND',
                                status: 404,
                                message: `organization not found: ${id}`,
                            });
                        }
                        return params;
                    }

                    return input;
                },
                async afterCrud(domain: string, action: string, output: unknown, serviceCtx: IServiceContext) {
                    if (domain !== 'organization') return output;
                    const meta = isRecord(serviceCtx.meta) ? serviceCtx.meta : undefined;
                    let userId: string | undefined;
                    if (meta) {
                        const user = meta['user'];
                        const directUserId = meta['userId'];
                        if (isRecord(user) && typeof user['id'] === 'string' && user['id'].length > 0) {
                            userId = user['id'];
                        } else if (typeof directUserId === 'string' && directUserId.length > 0) {
                            userId = directUserId;
                        }
                    }

                    if (action === 'create' && isRecord(output) && typeof output['id'] === 'string' && userId) {
                        const orgId = output['id'];
                        try {
                            await store.reownOrganization(orgId, userId);
                        } catch {
                            // Ignore if reown fails or already member
                        }
                    }
                    return output;
                },
            };

            await started.registerModule(organizationModule);

            await ensureFirstOperator(store, started);

            started.logger.info(`[identity] ready — ${String((await store.listRoles()).length)} roles`);
        },

        async onStop(stopped: IServiceBroker): Promise<void> {
            try {
                await stopped.unregisterModule('organization');
            } catch {
                // Ignore if not registered
            }
        },

        async execute(domain: string, action: string, input: unknown, _ctx: IServiceContext): Promise<unknown> {
            if (CRUD_DOMAINS.has(domain)) {
                throw new Error(`Engine Error: CRUD action "${action}" for domain "${domain}" was not intercepted.`);
            }

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

                /**
                 * **Set your own password, and claim a provisional account by doing it.**
                 *
                 * The one action the gate lets a provisional caller through, and until now it did
                 * not exist — so first boot produced an account that could do nothing at all,
                 * including stop being provisional. A wall with no door.
                 *
                 * **The subject is the caller.** There is no `userId` in the input, so this cannot
                 * become "change somebody's password" through a missing check; that is a different
                 * act, and it should have a different name and a different gate when it is wanted.
                 */
                case 'identity.set_password': {
                    const { password } = input as { password: string };
                    // The caller, from the meta the api resolved. Never from the input — see the contract.
                    const userId = (_ctx.meta as { user?: { id?: string } } | undefined)?.user?.id;

                    if (userId === undefined) {
                        throw new MeshError({
                            code: 'UNAUTHORIZED', status: 401,
                            message: 'Setting a password requires a session. The password is your own.',
                        });
                    }

                    const held = await store.getUser(userId);
                    if (held === undefined) {
                        throw new MeshError({ code: 'NOT_FOUND', status: 404, message: 'No such account.' });
                    }

                    const claimed = held.value.provisional === true;

                    await store.updateUser(userId, {
                        passwordHash: await hashPassword(password),
                        // Cleared here and nowhere else: claiming the account IS setting a password,
                        // so the two cannot come apart into a claimed account with the printed
                        // password still on it.
                        ...(claimed ? { provisional: false } : {}),
                    });

                    if (claimed) {
                        broker?.logger.warn(`[identity] provisional account ${held.value.email} claimed`);
                    }

                    return { ok: true as const, claimed };
                }

                case 'identity.sign_out': {
                    const { token } = input as { token: string };

                    /**
                     * Always the same answer.
                     *
                     * Signing out with a live ticket, an expired one, or one that was never issued
                     * all return `{ signedOut: true }` — because the difference is information about
                     * a credential the caller is claiming not to want any more, and an endpoint that
                     * distinguished them would tell an attacker holding a guessed token whether it
                     * was real.
                     *
                     * The revocation row is only appended for a ticket that existed, so a caller
                     * cannot make this collection grow by presenting nonsense.
                     */
                    const held = await store.getTicket(token);
                    if (held !== undefined && held.revokedAt === undefined) {
                        await store.markRevoked(token, now(), 'signed out');
                        await revoke('ticket', token, 'signed out');
                    }

                    return { signedOut: true as const };
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

                /**
                 * Grant or revoke a cluster-scoped role.
                 *
                 * The caller's own role is checked here rather than left to the site's gate. A gate
                 * is configuration and this contract hands out platform standing, so it verifies
                 * for itself — the same reasoning that puts `requireOperator` inside the fleet's
                 * handlers instead of trusting whoever wrote the site record.
                 */
                case 'identity.grant_role': {
                    const { userId, email, role, granted } = input as {
                        userId?: string; email?: string; role: string; granted?: boolean;
                    };

                    const caller = (_ctx.meta as { user?: { roles?: string[] } } | undefined)?.user;
                    if (!(caller?.roles ?? []).includes('operator')) {
                        throw new Error(
                            'identity.grant_role requires the operator role. The first operator is '
                            + 'named by MESH_BOOTSTRAP_OPERATOR in the node\'s environment.',
                        );
                    }

                    const found = userId !== undefined
                        ? await store.getUser(userId)
                        : email !== undefined ? await store.findUserByEmail(email) : undefined;

                    if (found === undefined) {
                        // Same wording whichever way the account was named: which addresses exist
                        // is not something a caller gets to enumerate, even an operator's caller.
                        throw new Error('No such account.');
                    }

                    const before = found.value.roles;
                    const after = granted === false
                        ? before.filter((r) => r !== role)
                        : [...new Set([...before, role])];

                    const changed = after.length !== before.length;
                    // The store refuses an organization-scoped role here, which is the check that
                    // keeps membership roles from being mistaken for platform standing.
                    if (changed) await store.updateUser(found.id, { roles: after });

                    _ctx.logger.warn(
                        `[identity] ${granted === false ? 'revoked' : 'granted'} "${role}" `
                        + `${granted === false ? 'from' : 'to'} ${found.value.email}`,
                    );

                    return { userId: found.id, roles: after, changed };
                }

                case 'identity.permits': {
                    const { roles, contract, organizationId } = input as {
                        roles: string[];
                        contract: string;
                        organizationId?: string;
                    };
                    const allRoles = await store.listRoles();
                    const resolvedRoles = roles
                        .map((key) => allRoles.find((r) => r.key === key))
                        .filter((r): r is Role => r !== undefined);
                    return {
                        permitted: permits(
                            resolvedRoles,
                            await store.listGrants(),
                            contract,
                            organizationId,
                        ),
                    };
                }

                case 'identity.api_token_validate': {
                    const { token } = apiTokenValidateContract.inputSchema.parse(input);
                    const hash = hashApiToken(token);
                    const found = await store.findApiToken(hash);

                    if (found === undefined) {
                        return { valid: false };
                    }
                    if (found.value.revokedAt !== undefined) {
                        return { valid: false };
                    }
                    if (found.value.expiresAt !== undefined && found.value.expiresAt <= now()) {
                        return { valid: false };
                    }

                    const user = await store.getUser(found.value.userId);
                    if (user === undefined || user.value.suspendedAt !== undefined) {
                        return { valid: false };
                    }

                    let organizationId = found.value.organizationId;
                    if (organizationId === undefined) {
                        const memberships = await store.membershipsOf(found.value.userId);
                        if (memberships.length === 1) {
                            const first = memberships[0];
                            if (first !== undefined) {
                                organizationId = first.organizationId;
                            }
                        }
                    }

                    let organizationSlug: string | undefined;
                    if (organizationId !== undefined) {
                        const org = await store.getOrganization(organizationId);
                        organizationSlug = org?.value.slug;
                    }

                    return {
                        valid: true,
                        userId: found.value.userId,
                        ...(organizationId !== undefined ? { organizationId } : {}),
                        ...(organizationSlug !== undefined ? { organizationSlug } : {}),
                        roles: Array.from(new Set([PUBLIC_ROLE, 'authenticated', ...found.value.roles])),
                        name: found.value.name,
                    };
                }

                case 'identity.api_token_issue': {
                    const parsed = apiTokenIssueContract.inputSchema.parse(input);
                    const targetUserId = parsed.userId;
                    const user = await store.getUser(targetUserId);
                    if (user === undefined) {
                        throw new Error(`User "${targetUserId}" does not exist.`);
                    }
                    if (parsed.organizationId !== undefined) {
                        const memberships = await store.membershipsOf(targetUserId);
                        const isMember = memberships.some((m) => m.organizationId === parsed.organizationId);
                        if (!isMember) {
                            throw new Error(`User "${targetUserId}" is not a member of organization "${parsed.organizationId}".`);
                        }
                    }

                    const token = mintToken();
                    const hash = hashApiToken(token);
                    const createdAt = now();
                    const expiresAt = parsed.expiresInMs !== undefined ? createdAt + parsed.expiresInMs : undefined;

                    const tokenRecord: ApiToken = {
                        tokenHash: hash,
                        name: parsed.name,
                        userId: targetUserId,
                        ...(parsed.organizationId !== undefined ? { organizationId: parsed.organizationId } : {}),
                        roles: parsed.roles ?? ['authenticated'],
                        createdAt,
                        ...(expiresAt !== undefined ? { expiresAt } : {}),
                    };

                    const stored = await store.createApiToken(tokenRecord);
                    return {
                        token,
                        tokenId: stored.id,
                        name: tokenRecord.name,
                        userId: tokenRecord.userId,
                        ...(tokenRecord.organizationId !== undefined ? { organizationId: tokenRecord.organizationId } : {}),
                        roles: tokenRecord.roles,
                        createdAt: tokenRecord.createdAt,
                        ...(tokenRecord.expiresAt !== undefined ? { expiresAt: tokenRecord.expiresAt } : {}),
                    };
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

function isRecord(obj: unknown): obj is Record<string, unknown> {
    return typeof obj === 'object' && obj !== null && !Array.isArray(obj);
}

/**
 * **The first account, made once, printed once.**
 *
 * A cluster with no users cannot be signed into, and every contract above `public` needs a session.
 * Something has to create the first person, and the two easy answers are both worse:
 *
 * - **A well-known default account** ships a platform pre-compromised. Everybody who has read the
 *   documentation has the password, including everybody who never intended to run one.
 * - **A tool that writes a user without being one** — which is what `src/bring-up.ts` does today —
 *   becomes the weakest thing in the system the moment it exists, and it authenticates differently
 *   from every other caller (the shape roadmap **F6** removed from `publish-cli`).
 *
 * So: identity makes one account, generates a real password, and prints it to **this process's own
 * stdout**. Whoever can read that log is already on the machine. It appears once and is never stored
 * anywhere it can be read back, because a credential a platform can recover is a credential a
 * platform can leak.
 *
 * The account is marked `provisional`, which the gate refuses above `public`. That is the difference
 * between a warning and a wall, and only the wall survives a busy week.
 */
async function ensureFirstOperator(store: IdentityStore, broker: IServiceBroker): Promise<void> {
    if (await store.anyUser()) return;

    /**
     * 24 bytes from the system CSPRNG, base64url.
     *
     * Not a memorable phrase: this is typed once, immediately, into `mesh-serve login`, and its only
     * job is to be unguessable for the minutes it exists.
     */
    const password = randomBytes(24).toString('base64url');
    /**
     * `.invalid` is reserved by RFC 2606 and can never resolve, which is the point: this address
     * must not be able to receive mail. `operator@localhost` was the first choice and it is not a
     * valid address at all — `UserSchema` refused it, and every `user.find` on a fresh cluster
     * failed validation rather than the account failing to be created, which is a worse way to find
     * out.
     */
    const email = process.env['MESH_FIRST_OPERATOR'] ?? 'operator@node.invalid';

    const created = await store.createUser({
        email,
        displayName: 'First operator',
        passwordHash: await hashPassword(password),
        // The role it will need, held from the start: an operator who has to grant themselves
        // operator is a chicken-and-egg with extra steps. The `provisional` flag is what stops it
        // being usable, not the absence of a role.
        roles: [FIRST_OPERATOR_ROLE],
        provisional: true,
    });

    /**
     * `process.stdout`, not the logger.
     *
     * A logger may be shipping to a file, a collection or another machine, and this is the one
     * string in the system that must not travel. It goes to the terminal of the person who started
     * the process and nowhere else.
     */
    process.stdout.write(
        `\n${'─'.repeat(72)}\n`
        + `  FIRST BOOT — no accounts existed, so one was created.\n\n`
        + `    email     ${email}\n`
        + `    password  ${password}\n\n`
        + `  This is shown once and is not recoverable. It can do nothing except set its own\n`
        + `  password — every other call is refused until it does.\n\n`
        + `    mesh-serve --host <site> login\n`
        + `${'─'.repeat(72)}\n\n`,
    );

    broker.logger.warn(`[identity] first boot: created provisional operator ${email} (${created.id})`);
}

/** The cluster-scoped role the first operator holds. Kept here so the two references cannot drift. */
const FIRST_OPERATOR_ROLE = 'operator';
