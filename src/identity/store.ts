/**
 * What identity needs to keep, and where.
 *
 * An interface rather than a database, for the same reason mesh-web's registry has providers: the
 * module's logic is the interesting part and it should be testable without mongo, and a deployment
 * that wants its users somewhere else should not have to fork the module to do it.
 *
 * The mongo-backed implementation is CRUD collections over the broker (C1.1). The in-memory one
 * below is what the tests use, and it is also a perfectly good single-node deployment.
 */

import type { ApiToken, Membership, Organization, User } from './schema/principals.js';
import type { Grant, Role } from './schema/roles.js';
import type { Revocation, Ticket } from './schema/tickets.js';

export interface Stored<T> { readonly id: string; readonly value: T }

export interface IdentityStore {
    createUser(user: User): Promise<Stored<User>>;
    findUserByEmail(email: string): Promise<Stored<User> | undefined>;
    getUser(id: string): Promise<Stored<User> | undefined>;
    updateUser(id: string, patch: Partial<User>): Promise<void>;

    createOrganization(org: Organization): Promise<Stored<Organization>>;
    getOrganization(id: string): Promise<Stored<Organization> | undefined>;

    createMembership(membership: Membership): Promise<Stored<Membership>>;
    membershipsOf(userId: string): Promise<readonly Membership[]>;

    listRoles(): Promise<readonly Role[]>;
    upsertRole(role: Role): Promise<void>;
    listGrants(): Promise<readonly Grant[]>;
    addGrant(grant: Grant): Promise<void>;

    createTicket(ticket: Ticket): Promise<void>;
    getTicket(token: string): Promise<Ticket | undefined>;
    /** Every live ticket for a principal — what `ticket_revoke` by `userId` has to end. */
    liveTicketsOf(userId: string): Promise<readonly Ticket[]>;
    markRevoked(token: string, at: number, reason?: string): Promise<void>;

    /**
     * Append a revocation and return the epoch it landed at.
     *
     * **The epoch has to be allocated here**, by whatever owns the sequence, rather than by a caller
     * computing `max + 1`. Two administrators revoking at once would otherwise both read the same
     * maximum and write the same epoch, and a poller asking for "everything after N" would miss one
     * of them — silently, and only under concurrency.
     */
    appendRevocation(revocation: Omit<Revocation, 'epoch'>): Promise<number>;
    revocationsSince(epoch: number, limit: number): Promise<readonly Revocation[]>;
    /** The newest epoch, and the oldest still retained — the second is how `truncated` is decided. */
    epochRange(): Promise<{ readonly newest: number; readonly oldest: number }>;

    createApiToken(token: ApiToken): Promise<Stored<ApiToken>>;
    findApiToken(hash: string): Promise<Stored<ApiToken> | undefined>;
}

// ---------------------------------------------------------------------------- in memory

/**
 * Everything in Maps.
 *
 * Not only for tests: a single-node deployment with a handful of users is a perfectly reasonable
 * thing, and this is the honest implementation of it. What it does not survive is a restart, which
 * `durability` would say out loud if this were a storage provider.
 */
export function memoryStore(): IdentityStore {
    const users = new Map<string, User>();
    const organizations = new Map<string, Organization>();
    const memberships: Membership[] = [];
    const roles = new Map<string, Role>();
    const grants: Grant[] = [];
    const tickets = new Map<string, Ticket>();
    const revocations: Revocation[] = [];
    const apiTokens = new Map<string, ApiToken>();

    let nextId = 0;
    let epoch = 0;

    const id = (prefix: string): string => `${prefix}-${String(++nextId)}`;

    return {
        async createUser(user) {
            const key = id('u');
            users.set(key, user);
            return { id: key, value: user };
        },
        async findUserByEmail(email) {
            for (const [key, value] of users) {
                if (value.email === email) return { id: key, value };
            }
            return undefined;
        },
        async getUser(key) {
            const value = users.get(key);
            return value === undefined ? undefined : { id: key, value };
        },
        async updateUser(key, patch) {
            const existing = users.get(key);
            if (existing !== undefined) users.set(key, { ...existing, ...patch });
        },

        async createOrganization(org) {
            const key = id('org');
            organizations.set(key, org);
            return { id: key, value: org };
        },
        async getOrganization(key) {
            const value = organizations.get(key);
            return value === undefined ? undefined : { id: key, value };
        },

        async createMembership(membership) {
            memberships.push(membership);
            return { id: id('m'), value: membership };
        },
        async membershipsOf(userId) {
            return memberships.filter((m) => m.userId === userId);
        },

        async listRoles() { return [...roles.values()]; },
        async upsertRole(role) { roles.set(role.key, role); },
        async listGrants() { return [...grants]; },
        async addGrant(grant) { grants.push(grant); },

        async createTicket(ticket) { tickets.set(ticket.token, ticket); },
        async getTicket(token) { return tickets.get(token); },
        async liveTicketsOf(userId) {
            return [...tickets.values()].filter((t) => t.userId === userId && t.revokedAt === undefined);
        },
        async markRevoked(token, at, reason) {
            const existing = tickets.get(token);
            if (existing !== undefined) {
                tickets.set(token, { ...existing, revokedAt: at, ...(reason === undefined ? {} : { revokedReason: reason }) });
            }
        },

        async appendRevocation(revocation) {
            epoch += 1;
            revocations.push({ ...revocation, epoch });
            return epoch;
        },
        async revocationsSince(since, limit) {
            return revocations.filter((r) => r.epoch > since).slice(0, limit);
        },
        async epochRange() {
            return { newest: epoch, oldest: revocations[0]?.epoch ?? 0 };
        },

        async createApiToken(token) {
            const key = id('at');
            apiTokens.set(token.tokenHash, token);
            return { id: key, value: token };
        },
        async findApiToken(hash) {
            const value = apiTokens.get(hash);
            return value === undefined ? undefined : { id: hash, value };
        },
    };
}
