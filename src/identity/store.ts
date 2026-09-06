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

import type { Database } from '@flybyme/mesh';
import { ClientError } from '@flybyme/mesh';
import type { Db } from 'mongodb';
import { ObjectId } from 'mongodb';

import {
    ApiTokenSchema,
    MembershipSchema,
    OrganizationSchema,
    UserSchema,
    type ApiToken,
    type Membership,
    type Organization,
    type User,
} from './schema/principals.js';
import { GrantSchema, RoleSchema, type Grant, type Role, type RoleScope } from './schema/roles.js';
import { RevocationSchema, TicketSchema, type Revocation, type Ticket } from './schema/tickets.js';

export interface Stored<T> { readonly id: string; readonly value: T }

export interface IdentityStore {
    createUser(user: User): Promise<Stored<User>>;
    findUserByEmail(email: string): Promise<Stored<User> | undefined>;
    getUser(id: string): Promise<Stored<User> | undefined>;
    updateUser(id: string, patch: Partial<User>): Promise<void>;

    createOrganization(org: Organization): Promise<Stored<Organization>>;
    getOrganization(id: string): Promise<Stored<Organization> | undefined>;
    transferOwnership(organizationId: string, currentOwnerId: string, newOwnerId: string): Promise<void>;
    reownOrganization(organizationId: string, userId: string): Promise<Stored<Membership>>;

    createMembership(membership: Membership): Promise<Stored<Membership>>;
    membershipsOf(userId: string): Promise<readonly Membership[]>;
    deleteMembership(organizationId: string, userId: string): Promise<void>;

    listRoles(): Promise<readonly Role[]>;
    getRole(key: string): Promise<Role | undefined>;
    upsertRole(role: Role): Promise<void>;
    deleteRole(key: string): Promise<void>;
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
            if (user.roles && user.roles.length > 0) {
                for (const roleKey of user.roles) {
                    const role = roles.get(roleKey);
                    if (role === undefined) {
                        throw new ClientError(`Role "${roleKey}" does not exist.`, 'ROLE_NOT_FOUND', 404);
                    }
                    if (role.scope !== 'cluster') {
                        throw new ClientError(
                            `Role "${roleKey}" is organization-scoped and cannot be added to user.roles. user.roles only holds cluster-scoped roles.`,
                            'INVALID_ROLE_SCOPE',
                            400,
                        );
                    }
                }
            }
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
            if (existing === undefined) {
                throw new ClientError(`User "${key}" does not exist.`, 'USER_NOT_FOUND', 404);
            }
            if (patch.roles !== undefined) {
                for (const roleKey of patch.roles) {
                    const role = roles.get(roleKey);
                    if (role === undefined) {
                        throw new ClientError(`Role "${roleKey}" does not exist.`, 'ROLE_NOT_FOUND', 404);
                    }
                    if (role.scope !== 'cluster') {
                        throw new ClientError(
                            `Role "${roleKey}" is organization-scoped and cannot be added to user.roles. user.roles only holds cluster-scoped roles.`,
                            'INVALID_ROLE_SCOPE',
                            400,
                        );
                    }
                }
            }
            users.set(key, { ...existing, ...patch });
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
        async transferOwnership(organizationId, currentOwnerId, newOwnerId) {
            const org = organizations.get(organizationId);
            if (org === undefined) {
                throw new ClientError(`Organization "${organizationId}" does not exist.`, 'ORG_NOT_FOUND', 404);
            }
            if (org.ownerId !== currentOwnerId) {
                throw new ClientError(
                    `Caller "${currentOwnerId}" is not the owner of organization "${organizationId}". Only the current owner can transfer ownership.`,
                    'NOT_OWNER',
                    403,
                );
            }
            const newOwner = users.get(newOwnerId);
            if (newOwner === undefined) {
                throw new ClientError(`User "${newOwnerId}" does not exist.`, 'USER_NOT_FOUND', 404);
            }

            organizations.set(organizationId, { ...org, ownerId: newOwnerId });

            const existingMembership = memberships.find(
                (m) => m.organizationId === organizationId && m.userId === newOwnerId,
            );
            if (existingMembership !== undefined) {
                existingMembership.roleKey = 'owner';
            } else {
                memberships.push({
                    userId: newOwnerId,
                    organizationId,
                    roleKey: 'owner',
                    joinedAt: Date.now(),
                });
            }
        },
        async reownOrganization(organizationId, userId) {
            const org = organizations.get(organizationId);
            if (org === undefined) {
                throw new ClientError(`Organization "${organizationId}" does not exist.`, 'ORG_NOT_FOUND', 404);
            }
            if (org.ownerId !== userId) {
                throw new ClientError(
                    `User "${userId}" is not the recorded owner of organization "${organizationId}".`,
                    'NOT_OWNER',
                    403,
                );
            }

            const existingMembership = memberships.find(
                (m) => m.organizationId === organizationId && m.userId === userId,
            );
            if (existingMembership !== undefined) {
                existingMembership.roleKey = 'owner';
                return { id: id('m'), value: existingMembership };
            }

            const newMembership: Membership = {
                userId,
                organizationId,
                roleKey: 'owner',
                joinedAt: Date.now(),
            };
            memberships.push(newMembership);
            return { id: id('m'), value: newMembership };
        },

        async createMembership(membership) {
            const role = roles.get(membership.roleKey);
            if (role === undefined) {
                throw new ClientError(`Role "${membership.roleKey}" does not exist.`, 'ROLE_NOT_FOUND', 404);
            }
            if (role.scope !== 'organization') {
                throw new ClientError(
                    `Role "${membership.roleKey}" is cluster-scoped and cannot be used as a membership roleKey. Memberships only hold organization-scoped roles.`,
                    'INVALID_ROLE_SCOPE',
                    400,
                );
            }
            memberships.push(membership);
            return { id: id('m'), value: membership };
        },
        async membershipsOf(userId) {
            return memberships.filter((m) => m.userId === userId);
        },
        async deleteMembership(organizationId, userId) {
            const idx = memberships.findIndex(
                (m) => m.organizationId === organizationId && m.userId === userId,
            );
            if (idx !== -1) {
                memberships.splice(idx, 1);
            }
        },

        async listRoles() { return [...roles.values()]; },
        async getRole(key) { return roles.get(key); },
        async upsertRole(role) { roles.set(role.key, role); },
        async deleteRole(key) {
            const role = roles.get(key);
            if (role === undefined) {
                throw new ClientError(`Role "${key}" does not exist.`, 'ROLE_NOT_FOUND', 404);
            }
            if (role.builtin) {
                throw new ClientError(
                    `Cannot delete builtin role "${key}": builtin roles are shipped with identity and not deletable.`,
                    'BUILTIN_ROLE',
                    400,
                );
            }
            roles.delete(key);
        },
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

// ---------------------------------------------------------------------------- mongo backed

interface UserDoc {
    _id: string;
    email: string;
    displayName: string;
    passwordHash?: string;
    roles: string[];
    suspendedAt?: number;
    suspendedReason?: string;
}

interface OrganizationDoc {
    _id: string;
    slug: string;
    name: string;
    ownerId: string;
}

interface MembershipDoc {
    _id: string;
    userId: string;
    organizationId: string;
    roleKey: string;
    invitedBy?: string;
    joinedAt: number;
}

interface RoleDoc {
    _id: string;
    key: string;
    name: string;
    scope: RoleScope;
    description?: string;
    builtin: boolean;
}

interface GrantDoc {
    roleKey: string;
    contract: string;
    description?: string;
}

interface TicketDoc {
    _id: string;
    token: string;
    userId: string;
    roles: string[];
    issuedAt: number;
    expiresAt: number;
    expireAt: Date;
    via: string;
    revokedAt?: number;
    revokedReason?: string;
}

interface RevocationDoc {
    epoch: number;
    kind: 'ticket' | 'principal';
    subject: string;
    at: number;
    reason?: string;
}

interface CounterDoc {
    _id: string;
    seq: number;
}

interface ApiTokenDoc {
    _id: string;
    tokenHash: string;
    name: string;
    userId: string;
    organizationId?: string;
    roles: string[];
    createdAt: number;
    lastUsedAt?: number;
    expiresAt?: number;
    revokedAt?: number;
}

/**
 * A MongoDB-backed IdentityStore implementation.
 *
 * Persists users, organizations, memberships, roles, grants, tickets, revocations, and API tokens
 * to a MongoDB database.
 *
 * - Unique index on `user.email` prevents duplicate registrations.
 * - Index on `ticket.token` provides fast lookups on every authenticated request.
 * - TTL index on `ticket.expireAt` lets MongoDB sweep expired tickets in the background.
 * - Atomic sequence counter on `counter.revocation_epoch` maintains monotonic revocation ordering.
 */
export function mongoStore(database: Database | Db): IdentityStore {
    let readyPromise: Promise<void> | undefined;

    function getDb(): Db {
        if ('getDb' in database) {
            const db = database.getDb();
            if (db === null) {
                throw new Error('Database not connected. Call connect() first.');
            }
            return db;
        }
        return database;
    }

    function getCollections() {
        const db = getDb();
        return {
            users: db.collection<UserDoc>('user'),
            organizations: db.collection<OrganizationDoc>('organization'),
            memberships: db.collection<MembershipDoc>('membership'),
            roles: db.collection<RoleDoc>('role'),
            grants: db.collection<GrantDoc>('grant'),
            tickets: db.collection<TicketDoc>('ticket'),
            revocations: db.collection<RevocationDoc>('revocation'),
            counters: db.collection<CounterDoc>('counter'),
            apiTokens: db.collection<ApiTokenDoc>('apiToken'),
        };
    }

    async function ensureReady(): Promise<void> {
        if (readyPromise === undefined) {
            readyPromise = (async () => {
                const cols = getCollections();
                await Promise.all([
                    cols.users.createIndex({ email: 1 }, { unique: true, name: 'uniq_user_email' }),
                    cols.tickets.createIndex({ token: 1 }, { unique: true, name: 'uniq_ticket_token' }),
                    cols.tickets.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }),
                    cols.tickets.createIndex({ userId: 1 }),
                    cols.revocations.createIndex({ epoch: 1 }, { unique: true }),
                    cols.roles.createIndex({ key: 1 }, { unique: true, name: 'uniq_role_key' }),
                    cols.apiTokens.createIndex({ tokenHash: 1 }, { unique: true, name: 'uniq_apiToken_tokenHash' }),
                    cols.organizations.createIndex({ slug: 1 }, { unique: true, name: 'uniq_organization_slug' }),
                    cols.memberships.createIndex({ userId: 1 }),
                    cols.memberships.createIndex(
                        { organizationId: 1, userId: 1 },
                        { unique: true, name: 'uniq_membership_organizationId_userId' },
                    ),
                    cols.grants.createIndex(
                        { roleKey: 1, contract: 1 },
                        { unique: true, name: 'uniq_grant_roleKey_contract' },
                    ),
                ]);
            })().catch((err: unknown) => {
                readyPromise = undefined;
                throw err;
            });
        }
        return readyPromise;
    }

    const id = (prefix: string): string => `${prefix}-${new ObjectId().toHexString()}`;

    async function fetchRole(key: string): Promise<Role | undefined> {
        await ensureReady();
        const cols = getCollections();
        const doc = await cols.roles.findOne({ key });
        if (doc === null) return undefined;
        return RoleSchema.parse(doc);
    }

    return {
        async createUser(user) {
            await ensureReady();
            if (user.roles && user.roles.length > 0) {
                for (const roleKey of user.roles) {
                    const role = await fetchRole(roleKey);
                    if (role === undefined) {
                        throw new ClientError(`Role "${roleKey}" does not exist.`, 'ROLE_NOT_FOUND', 404);
                    }
                    if (role.scope !== 'cluster') {
                        throw new ClientError(
                            `Role "${roleKey}" is organization-scoped and cannot be added to user.roles. user.roles only holds cluster-scoped roles.`,
                            'INVALID_ROLE_SCOPE',
                            400,
                        );
                    }
                }
            }
            const key = id('u');
            const cols = getCollections();
            await cols.users.insertOne({
                _id: key,
                email: user.email,
                displayName: user.displayName,
                ...(user.passwordHash !== undefined ? { passwordHash: user.passwordHash } : {}),
                roles: [...user.roles],
                ...(user.suspendedAt !== undefined ? { suspendedAt: user.suspendedAt } : {}),
                ...(user.suspendedReason !== undefined ? { suspendedReason: user.suspendedReason } : {}),
            });
            return { id: key, value: user };
        },

        async findUserByEmail(email) {
            await ensureReady();
            const cols = getCollections();
            const doc = await cols.users.findOne({ email });
            if (doc === null) return undefined;
            return { id: doc._id, value: UserSchema.parse(doc) };
        },

        async getUser(key) {
            await ensureReady();
            const cols = getCollections();
            const doc = await cols.users.findOne({ _id: key });
            if (doc === null) return undefined;
            return { id: doc._id, value: UserSchema.parse(doc) };
        },

        async updateUser(key, patch) {
            await ensureReady();
            const cols = getCollections();
            const existing = await cols.users.findOne({ _id: key });
            if (existing === null) {
                throw new ClientError(`User "${key}" does not exist.`, 'USER_NOT_FOUND', 404);
            }
            if (patch.roles !== undefined) {
                for (const roleKey of patch.roles) {
                    const role = await fetchRole(roleKey);
                    if (role === undefined) {
                        throw new ClientError(`Role "${roleKey}" does not exist.`, 'ROLE_NOT_FOUND', 404);
                    }
                    if (role.scope !== 'cluster') {
                        throw new ClientError(
                            `Role "${roleKey}" is organization-scoped and cannot be added to user.roles. user.roles only holds cluster-scoped roles.`,
                            'INVALID_ROLE_SCOPE',
                            400,
                        );
                    }
                }
            }
            await cols.users.updateOne({ _id: key }, { $set: patch });
        },

        async createOrganization(org) {
            await ensureReady();
            const key = id('org');
            const cols = getCollections();
            await cols.organizations.insertOne({
                _id: key,
                slug: org.slug,
                name: org.name,
                ownerId: org.ownerId,
            });
            return { id: key, value: org };
        },

        async getOrganization(key) {
            await ensureReady();
            const cols = getCollections();
            const doc = await cols.organizations.findOne({ _id: key });
            if (doc === null) return undefined;
            return { id: doc._id, value: OrganizationSchema.parse(doc) };
        },

        async transferOwnership(organizationId, currentOwnerId, newOwnerId) {
            await ensureReady();
            const cols = getCollections();
            const org = await cols.organizations.findOne({ _id: organizationId });
            if (org === null) {
                throw new ClientError(`Organization "${organizationId}" does not exist.`, 'ORG_NOT_FOUND', 404);
            }
            if (org.ownerId !== currentOwnerId) {
                throw new ClientError(
                    `Caller "${currentOwnerId}" is not the owner of organization "${organizationId}". Only the current owner can transfer ownership.`,
                    'NOT_OWNER',
                    403,
                );
            }
            const newOwner = await cols.users.findOne({ _id: newOwnerId });
            if (newOwner === null) {
                throw new ClientError(`User "${newOwnerId}" does not exist.`, 'USER_NOT_FOUND', 404);
            }

            await cols.organizations.updateOne({ _id: organizationId }, { $set: { ownerId: newOwnerId } });

            const existingMembership = await cols.memberships.findOne({
                organizationId,
                userId: newOwnerId,
            });
            if (existingMembership !== null) {
                await cols.memberships.updateOne({ _id: existingMembership._id }, { $set: { roleKey: 'owner' } });
            } else {
                await cols.memberships.insertOne({
                    _id: id('m'),
                    userId: newOwnerId,
                    organizationId,
                    roleKey: 'owner',
                    joinedAt: Date.now(),
                });
            }
        },

        async reownOrganization(organizationId, userId) {
            await ensureReady();
            const cols = getCollections();
            const org = await cols.organizations.findOne({ _id: organizationId });
            if (org === null) {
                throw new ClientError(`Organization "${organizationId}" does not exist.`, 'ORG_NOT_FOUND', 404);
            }
            if (org.ownerId !== userId) {
                throw new ClientError(
                    `User "${userId}" is not the recorded owner of organization "${organizationId}".`,
                    'NOT_OWNER',
                    403,
                );
            }

            const existingMembership = await cols.memberships.findOne({
                organizationId,
                userId,
            });
            if (existingMembership !== null) {
                await cols.memberships.updateOne({ _id: existingMembership._id }, { $set: { roleKey: 'owner' } });
                const parsed = MembershipSchema.parse(existingMembership);
                return {
                    id: existingMembership._id,
                    value: {
                        userId: parsed.userId,
                        organizationId: parsed.organizationId,
                        roleKey: 'owner',
                        ...(parsed.invitedBy !== undefined ? { invitedBy: parsed.invitedBy } : {}),
                        joinedAt: parsed.joinedAt,
                    },
                };
            }

            const newMembership: Membership = {
                userId,
                organizationId,
                roleKey: 'owner',
                joinedAt: Date.now(),
            };
            const memId = id('m');
            await cols.memberships.insertOne({ _id: memId, ...newMembership });
            return { id: memId, value: newMembership };
        },

        async createMembership(membership) {
            await ensureReady();
            const role = await fetchRole(membership.roleKey);
            if (role === undefined) {
                throw new ClientError(`Role "${membership.roleKey}" does not exist.`, 'ROLE_NOT_FOUND', 404);
            }
            if (role.scope !== 'organization') {
                throw new ClientError(
                    `Role "${membership.roleKey}" is cluster-scoped and cannot be used as a membership roleKey. Memberships only hold organization-scoped roles.`,
                    'INVALID_ROLE_SCOPE',
                    400,
                );
            }
            const memId = id('m');
            const cols = getCollections();
            await cols.memberships.insertOne({ _id: memId, ...membership });
            return { id: memId, value: membership };
        },

        async membershipsOf(userId) {
            await ensureReady();
            const cols = getCollections();
            const docs = await cols.memberships.find({ userId }).toArray();
            return docs.map((doc) => MembershipSchema.parse(doc));
        },

        async deleteMembership(organizationId, userId) {
            await ensureReady();
            const cols = getCollections();
            await cols.memberships.deleteOne({ organizationId, userId });
        },

        async listRoles() {
            await ensureReady();
            const cols = getCollections();
            const docs = await cols.roles.find({}).toArray();
            return docs.map((doc) => RoleSchema.parse(doc));
        },

        async getRole(key) {
            return fetchRole(key);
        },

        async upsertRole(role) {
            await ensureReady();
            const cols = getCollections();
            await cols.roles.replaceOne(
                { key: role.key },
                {
                    key: role.key,
                    name: role.name,
                    scope: role.scope,
                    ...(role.description !== undefined ? { description: role.description } : {}),
                    builtin: role.builtin,
                },
                { upsert: true },
            );
        },

        async deleteRole(key) {
            await ensureReady();
            const role = await fetchRole(key);
            if (role === undefined) {
                throw new ClientError(`Role "${key}" does not exist.`, 'ROLE_NOT_FOUND', 404);
            }
            if (role.builtin) {
                throw new ClientError(
                    `Cannot delete builtin role "${key}": builtin roles are shipped with identity and not deletable.`,
                    'BUILTIN_ROLE',
                    400,
                );
            }
            const cols = getCollections();
            await cols.roles.deleteOne({ key });
        },

        async listGrants() {
            await ensureReady();
            const cols = getCollections();
            const docs = await cols.grants.find({}).toArray();
            return docs.map((doc) => GrantSchema.parse(doc));
        },

        async addGrant(grant) {
            await ensureReady();
            const cols = getCollections();
            await cols.grants.insertOne({
                roleKey: grant.roleKey,
                contract: grant.contract,
                ...(grant.description !== undefined ? { description: grant.description } : {}),
            });
        },

        async createTicket(ticket) {
            await ensureReady();
            const cols = getCollections();
            await cols.tickets.insertOne({
                _id: ticket.token,
                token: ticket.token,
                userId: ticket.userId,
                roles: [...ticket.roles],
                issuedAt: ticket.issuedAt,
                expiresAt: ticket.expiresAt,
                expireAt: new Date(ticket.expiresAt),
                via: ticket.via,
                ...(ticket.revokedAt !== undefined ? { revokedAt: ticket.revokedAt } : {}),
                ...(ticket.revokedReason !== undefined ? { revokedReason: ticket.revokedReason } : {}),
            });
        },

        async getTicket(token) {
            await ensureReady();
            const cols = getCollections();
            const doc = await cols.tickets.findOne({ token });
            if (doc === null) return undefined;
            return TicketSchema.parse(doc);
        },

        async liveTicketsOf(userId) {
            await ensureReady();
            const cols = getCollections();
            const docs = await cols.tickets.find({ userId, revokedAt: { $exists: false } }).toArray();
            return docs.map((doc) => TicketSchema.parse(doc)).filter((t) => t.revokedAt === undefined);
        },

        async markRevoked(token, at, reason) {
            await ensureReady();
            const cols = getCollections();
            await cols.tickets.updateOne(
                { token },
                {
                    $set: {
                        revokedAt: at,
                        ...(reason !== undefined ? { revokedReason: reason } : {}),
                    },
                },
            );
        },

        async appendRevocation(revocation) {
            await ensureReady();
            const cols = getCollections();
            const counterDoc = await cols.counters.findOneAndUpdate(
                { _id: 'revocation_epoch' },
                { $inc: { seq: 1 } },
                { upsert: true, returnDocument: 'after' },
            );
            const epoch = counterDoc !== null ? counterDoc.seq : 1;
            await cols.revocations.insertOne({
                epoch,
                kind: revocation.kind,
                subject: revocation.subject,
                at: revocation.at,
                ...(revocation.reason !== undefined ? { reason: revocation.reason } : {}),
            });
            return epoch;
        },

        async revocationsSince(since, limit) {
            await ensureReady();
            const cols = getCollections();
            const docs = await cols.revocations
                .find({ epoch: { $gt: since } })
                .sort({ epoch: 1 })
                .limit(limit)
                .toArray();
            return docs.map((doc) => RevocationSchema.parse(doc));
        },

        async epochRange() {
            await ensureReady();
            const cols = getCollections();
            const counterDoc = await cols.counters.findOne({ _id: 'revocation_epoch' });
            const newest = counterDoc !== null ? counterDoc.seq : 0;
            const oldestDoc = await cols.revocations.findOne({}, { sort: { epoch: 1 } });
            const oldest = oldestDoc !== null ? oldestDoc.epoch : 0;
            return { newest, oldest };
        },

        async createApiToken(token) {
            await ensureReady();
            const key = id('at');
            const cols = getCollections();
            await cols.apiTokens.insertOne({
                _id: key,
                tokenHash: token.tokenHash,
                name: token.name,
                userId: token.userId,
                ...(token.organizationId !== undefined ? { organizationId: token.organizationId } : {}),
                roles: [...token.roles],
                createdAt: token.createdAt,
                ...(token.lastUsedAt !== undefined ? { lastUsedAt: token.lastUsedAt } : {}),
                ...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}),
                ...(token.revokedAt !== undefined ? { revokedAt: token.revokedAt } : {}),
            });
            return { id: key, value: token };
        },

        async findApiToken(hash) {
            await ensureReady();
            const cols = getCollections();
            const doc = await cols.apiTokens.findOne({ tokenHash: hash });
            if (doc === null) return undefined;
            return { id: hash, value: ApiTokenSchema.parse(doc) };
        },
    };
}

