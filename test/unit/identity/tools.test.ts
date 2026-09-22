import { describe, expect, it } from 'vitest';
import { MeshError } from '@flybyme/mesh';
import { createMockContext } from '../helpers/mockContext.js';
import { hashPassword } from '../../../src/identity/methods/hash.js';
import { hasRole } from '../../../src/identity/tools/hasRole.js';
import { permits } from '../../../src/identity/tools/permits.js';
import { issueTicket } from '../../../src/identity/tools/issueTicket.js';
import { validateTicket } from '../../../src/identity/tools/validateTicket.js';
import { validateApiToken } from '../../../src/identity/tools/validateApiToken.js';
import { revokeTicket } from '../../../src/identity/tools/revokeTicket.js';
import { signOut } from '../../../src/identity/tools/signOut.js';

describe('identity tools', () => {
    describe('hasRole', () => {
        it('returns granted: true when user directly holds the role', async () => {
            const { ctx } = createMockContext({
                handlers: {
                    'identity.user.resolve': async () => ({ id: 'u1', roles: ['admin'] }),
                    'identity.role.find': async () => [
                        { key: 'admin', permissions: ['*'], inherits: [] },
                    ],
                },
            });

            const result = await hasRole({ userId: 'u1', role: 'admin' }, ctx);
            expect(result).toEqual({ granted: true });
        });

        it('returns granted: true when role is acquired via inheritance', async () => {
            const { ctx } = createMockContext({
                handlers: {
                    'identity.user.resolve': async () => ({ id: 'u1', roles: ['lead'] }),
                    'identity.role.find': async () => [
                        { key: 'viewer', permissions: ['read'], inherits: [] },
                        { key: 'developer', permissions: ['write'], inherits: ['viewer'] },
                        { key: 'lead', permissions: ['admin'], inherits: ['developer'] },
                    ],
                },
            });

            const resultViewer = await hasRole({ userId: 'u1', role: 'viewer' }, ctx);
            expect(resultViewer).toEqual({ granted: true });

            const resultDev = await hasRole({ userId: 'u1', role: 'developer' }, ctx);
            expect(resultDev).toEqual({ granted: true });
        });

        it('returns granted: true for organization-scoped role via membership when organizationId is provided', async () => {
            const { ctx } = createMockContext({
                handlers: {
                    'identity.user.resolve': async () => ({ id: 'u1', roles: ['viewer'] }),
                    'identity.membership.find_one': async ({ query }) => {
                        if (query.userId === 'u1' && query.organizationId === 'org-1') {
                            return { id: 'mem-1', roleKey: 'org-admin' };
                        }
                        return undefined;
                    },
                    'identity.role.find_one': async ({ query }) => {
                        if (query.key === 'org-admin') {
                            return { key: 'org-admin', scope: 'organization' };
                        }
                        return undefined;
                    },
                    'identity.role.find': async () => [
                        { key: 'viewer', permissions: [], inherits: [] },
                        { key: 'org-admin', permissions: [], inherits: [] },
                    ],
                },
            });

            const result = await hasRole(
                { userId: 'u1', role: 'org-admin', organizationId: 'org-1' },
                ctx
            );
            expect(result).toEqual({ granted: true });
        });

        it('returns granted: false when user does not hold the role', async () => {
            const { ctx } = createMockContext({
                handlers: {
                    'identity.user.resolve': async () => ({ id: 'u1', roles: ['viewer'] }),
                    'identity.role.find': async () => [
                        { key: 'viewer', permissions: [], inherits: [] },
                        { key: 'admin', permissions: [], inherits: [] },
                    ],
                },
            });

            const result = await hasRole({ userId: 'u1', role: 'admin' }, ctx);
            expect(result).toEqual({ granted: false });
        });

        it('returns granted: false when user is not found', async () => {
            const { ctx } = createMockContext({
                handlers: {
                    'identity.user.resolve': async () => undefined,
                    'identity.role.find': async () => [],
                },
            });

            const result = await hasRole({ userId: 'missing', role: 'admin' }, ctx);
            expect(result).toEqual({ granted: false });
        });

        it('returns granted: false for organization role if organizationId is not supplied', async () => {
            const { ctx } = createMockContext({
                handlers: {
                    'identity.user.resolve': async () => ({ id: 'u1', roles: [] }),
                    'identity.role.find': async () => [
                        { key: 'org-admin', permissions: [], inherits: [] },
                    ],
                },
            });

            const result = await hasRole({ userId: 'u1', role: 'org-admin' }, ctx);
            expect(result).toEqual({ granted: false });
        });

        it('returns granted: false when membership attempts to grant global scope role', async () => {
            const { ctx } = createMockContext({
                handlers: {
                    'identity.user.resolve': async () => ({ id: 'u1', roles: [] }),
                    'identity.membership.find_one': async () => ({ id: 'mem-1', roleKey: 'operator' }),
                    'identity.role.find_one': async () => ({ key: 'operator', scope: 'global' }),
                    'identity.role.find': async () => [
                        { key: 'operator', permissions: [], inherits: [] },
                    ],
                },
            });

            const result = await hasRole(
                { userId: 'u1', role: 'operator', organizationId: 'org-1' },
                ctx
            );
            expect(result).toEqual({ granted: false });
        });
    });

    describe('permits', () => {
        it('returns permitted: false immediately when user has no roles without fetching roles', async () => {
            const { ctx, calls } = createMockContext({
                handlers: {
                    'identity.user.resolve': async () => ({ id: 'u1', roles: [] }),
                },
            });

            const result = await permits({ userId: 'u1', contract: 'identity.user.create' }, ctx);

            expect(result).toEqual({ permitted: false });
            expect(calls.some((c) => c.action === 'identity.role.find')).toBe(false);
        });

        it('returns permitted: true for exact contract match', async () => {
            const { ctx } = createMockContext({
                handlers: {
                    'identity.user.resolve': async () => ({ id: 'u1', roles: ['user-creator'] }),
                    'identity.role.find': async () => [
                        { key: 'user-creator', permissions: ['identity.user.create'], inherits: [] },
                    ],
                },
            });

            const result = await permits(
                { userId: 'u1', contract: 'identity.user.create' },
                ctx
            );
            expect(result).toEqual({ permitted: true });
        });

        it('returns permitted: true for wildcard domain.* pattern', async () => {
            const { ctx } = createMockContext({
                handlers: {
                    'identity.user.resolve': async () => ({ id: 'u1', roles: ['operator'] }),
                    'identity.role.find': async () => [
                        { key: 'operator', permissions: ['identity.*', 'serve.*'], inherits: [] },
                    ],
                },
            });

            const result1 = await permits(
                { userId: 'u1', contract: 'identity.ticket.issue' },
                ctx
            );
            expect(result1).toEqual({ permitted: true });

            const result2 = await permits(
                { userId: 'u1', contract: 'serve.expose.create' },
                ctx
            );
            expect(result2).toEqual({ permitted: true });
        });

        it('returns permitted: true when permission is inherited from ancestor role', async () => {
            const { ctx } = createMockContext({
                handlers: {
                    'identity.user.resolve': async () => ({ id: 'u1', roles: ['admin'] }),
                    'identity.role.find': async () => [
                        { key: 'viewer', permissions: ['catalog.artifact.get'], inherits: [] },
                        { key: 'admin', permissions: ['identity.user.*'], inherits: ['viewer'] },
                    ],
                },
            });

            const result = await permits(
                { userId: 'u1', contract: 'catalog.artifact.get' },
                ctx
            );
            expect(result).toEqual({ permitted: true });
        });

        it('returns permitted: true for permission granted via organization membership', async () => {
            const { ctx } = createMockContext({
                handlers: {
                    'identity.user.resolve': async () => ({ id: 'u1', roles: [] }),
                    'identity.membership.find_one': async () => ({ id: 'mem-1', roleKey: 'org-maintainer' }),
                    'identity.role.find_one': async () => ({ key: 'org-maintainer', scope: 'organization' }),
                    'identity.role.find': async () => [
                        { key: 'org-maintainer', permissions: ['serve.repo.*'], inherits: [] },
                    ],
                },
            });

            const result = await permits(
                { userId: 'u1', contract: 'serve.repo.create', organizationId: 'org-1' },
                ctx
            );
            expect(result).toEqual({ permitted: true });
        });

        it('returns permitted: false when permission pattern does not match contract', async () => {
            const { ctx } = createMockContext({
                handlers: {
                    'identity.user.resolve': async () => ({ id: 'u1', roles: ['viewer'] }),
                    'identity.role.find': async () => [
                        { key: 'viewer', permissions: ['identity.user.resolve'], inherits: [] },
                    ],
                },
            });

            const result = await permits(
                { userId: 'u1', contract: 'identity.user.delete' },
                ctx
            );
            expect(result).toEqual({ permitted: false });
        });

        it('returns permitted: false when organizationId is omitted for org-scoped permission', async () => {
            const { ctx } = createMockContext({
                handlers: {
                    'identity.user.resolve': async () => ({ id: 'u1', roles: [] }),
                    'identity.role.find': async () => [
                        { key: 'org-maintainer', permissions: ['serve.repo.*'], inherits: [] },
                    ],
                },
            });

            const result = await permits(
                { userId: 'u1', contract: 'serve.repo.create' },
                ctx
            );
            expect(result).toEqual({ permitted: false });
        });

        it('returns permitted: false on prefix edge case (identity.* does not match identity_logs.read)', async () => {
            const { ctx } = createMockContext({
                handlers: {
                    'identity.user.resolve': async () => ({ id: 'u1', roles: ['operator'] }),
                    'identity.role.find': async () => [
                        { key: 'operator', permissions: ['identity.*'], inherits: [] },
                    ],
                },
            });

            const result = await permits(
                { userId: 'u1', contract: 'identity_logs.read' },
                ctx
            );
            expect(result).toEqual({ permitted: false });
        });
    });

    describe('issueTicket', () => {
        const testPassword = 'SecurePassword123!';

        describe('credential verification', () => {
            it('throws MeshError 401 INVALID_CREDENTIALS if user is not found', async () => {
                const { ctx } = createMockContext({
                    handlers: {
                        'identity.user.find_one': async () => undefined,
                    },
                });

                await expect(
                    issueTicket({ email: 'unknown@test.invalid', password: testPassword }, ctx)
                ).rejects.toSatisfy((err: unknown) => {
                    expect(err).toBeInstanceOf(MeshError);
                    const meshErr = err as MeshError;
                    expect(meshErr.code).toBe('INVALID_CREDENTIALS');
                    expect(meshErr.status).toBe(401);
                    expect(meshErr.message).toBe('Invalid email or password.');
                    return true;
                });
            });

            it('throws MeshError 401 INVALID_CREDENTIALS if password does not match', async () => {
                const passwordHash = await hashPassword(testPassword);
                const { ctx } = createMockContext({
                    handlers: {
                        'identity.user.find_one': async () => ({
                            id: 'u1',
                            email: 'user@test.invalid',
                            passwordHash,
                            roles: ['viewer'],
                        }),
                    },
                });

                await expect(
                    issueTicket({ email: 'user@test.invalid', password: 'WrongPassword!' }, ctx)
                ).rejects.toSatisfy((err: unknown) => {
                    expect(err).toBeInstanceOf(MeshError);
                    const meshErr = err as MeshError;
                    expect(meshErr.code).toBe('INVALID_CREDENTIALS');
                    expect(meshErr.status).toBe(401);
                    return true;
                });
            });

            it('throws MeshError 401 INVALID_CREDENTIALS if user has no passwordHash', async () => {
                const { ctx } = createMockContext({
                    handlers: {
                        'identity.user.find_one': async () => ({
                            id: 'u1',
                            email: 'user@test.invalid',
                            passwordHash: undefined,
                            roles: [],
                        }),
                    },
                });

                await expect(
                    issueTicket({ email: 'user@test.invalid', password: testPassword }, ctx)
                ).rejects.toSatisfy((err: unknown) => {
                    expect(err).toBeInstanceOf(MeshError);
                    const meshErr = err as MeshError;
                    expect(meshErr.code).toBe('INVALID_CREDENTIALS');
                    expect(meshErr.status).toBe(401);
                    return true;
                });
            });
        });

        describe('suspended account check', () => {
            it('throws MeshError 403 SUSPENDED when user is suspended with custom reason', async () => {
                const passwordHash = await hashPassword(testPassword);
                const { ctx } = createMockContext({
                    handlers: {
                        'identity.user.find_one': async () => ({
                            id: 'u1',
                            email: 'suspended@test.invalid',
                            passwordHash,
                            suspendedAt: new Date(),
                            suspendedReason: 'Account terminated due to policy violation.',
                        }),
                    },
                });

                await expect(
                    issueTicket({ email: 'suspended@test.invalid', password: testPassword }, ctx)
                ).rejects.toSatisfy((err: unknown) => {
                    expect(err).toBeInstanceOf(MeshError);
                    const meshErr = err as MeshError;
                    expect(meshErr.code).toBe('SUSPENDED');
                    expect(meshErr.status).toBe(403);
                    expect(meshErr.message).toBe('Account terminated due to policy violation.');
                    return true;
                });
            });

            it('throws MeshError 403 SUSPENDED with default message when suspendedReason is undefined', async () => {
                const passwordHash = await hashPassword(testPassword);
                const { ctx } = createMockContext({
                    handlers: {
                        'identity.user.find_one': async () => ({
                            id: 'u1',
                            email: 'suspended@test.invalid',
                            passwordHash,
                            suspendedAt: new Date(),
                            suspendedReason: undefined,
                        }),
                    },
                });

                await expect(
                    issueTicket({ email: 'suspended@test.invalid', password: testPassword }, ctx)
                ).rejects.toSatisfy((err: unknown) => {
                    expect(err).toBeInstanceOf(MeshError);
                    const meshErr = err as MeshError;
                    expect(meshErr.code).toBe('SUSPENDED');
                    expect(meshErr.status).toBe(403);
                    expect(meshErr.message).toBe('Account suspended.');
                    return true;
                });
            });
        });

        describe('successful issuance & 24h expiration', () => {
            it('creates ticket with 24h TTL and returns token, userId, and expiresAt', async () => {
                const passwordHash = await hashPassword(testPassword);
                const createdTickets: any[] = [];
                const beforeCall = Date.now();

                const { ctx } = createMockContext({
                    handlers: {
                        'identity.user.find_one': async () => ({
                            id: 'u-123',
                            email: 'valid@test.invalid',
                            passwordHash,
                            roles: ['operator', 'admin'],
                        }),
                        'identity.ticket.create': async (params) => {
                            createdTickets.push(params);
                            return params;
                        },
                    },
                });

                const result = await issueTicket(
                    { email: 'valid@test.invalid', password: testPassword },
                    ctx
                );

                const afterCall = Date.now();
                const expectedTtlMs = 24 * 60 * 60 * 1000;

                // Return payload verification
                expect(result.token).toHaveLength(64);
                expect(result.token).toMatch(/^[0-9a-f]{64}$/);
                expect(result.userId).toBe('u-123');
                expect(result.expiresAt).toBeGreaterThanOrEqual(beforeCall + expectedTtlMs);
                expect(result.expiresAt).toBeLessThanOrEqual(afterCall + expectedTtlMs);

                // identity.ticket.create call verification
                expect(createdTickets).toHaveLength(1);
                const created = createdTickets[0];
                expect(created.token).toBe(result.token);
                expect(created.userId).toBe('u-123');
                expect(created.roles).toEqual(['operator', 'admin']);
                expect(created.issuedAt).toBeInstanceOf(Date);
                expect(created.expiresAt).toBeInstanceOf(Date);
                expect(created.expiresAt.getTime() - created.issuedAt.getTime()).toBe(expectedTtlMs);
                expect(created.via).toBe('login');
            });

            it('records custom via parameter when provided', async () => {
                const passwordHash = await hashPassword(testPassword);
                let capturedVia: string | undefined;

                const { ctx } = createMockContext({
                    handlers: {
                        'identity.user.find_one': async () => ({
                            id: 'u-123',
                            email: 'valid@test.invalid',
                            passwordHash,
                            roles: [],
                        }),
                        'identity.ticket.create': async (params) => {
                            capturedVia = params.via;
                            return params;
                        },
                    },
                });

                await issueTicket(
                    { email: 'valid@test.invalid', password: testPassword, via: 'password_reset' },
                    ctx
                );

                expect(capturedVia).toBe('password_reset');
            });
        });
    });

    describe('validateApiToken', () => {
        it('returns the token\'s own organizationId when it has one', async () => {
            const { ctx } = createMockContext({
                handlers: {
                    'identity.apiToken.find_one': async () => ({
                        userId: 'u-789',
                        organizationId: 'org-42',
                        roles: ['operator'],
                        name: 'ci-token',
                        revokedAt: undefined,
                        expiresAt: undefined,
                    }),
                },
            });

            const result = await validateApiToken({ token: 'any-token' }, ctx);

            expect(result).toEqual({
                valid: true,
                userId: 'u-789',
                organizationId: 'org-42',
                roles: ['operator'],
                name: 'ci-token',
            });
        });

        it('omits organizationId for a token with no organization scope, rather than sending null', async () => {
            const { ctx } = createMockContext({
                handlers: {
                    'identity.apiToken.find_one': async () => ({
                        userId: 'u-789',
                        organizationId: undefined,
                        roles: [],
                        name: 'personal-token',
                        revokedAt: undefined,
                        expiresAt: undefined,
                    }),
                },
            });

            const result = await validateApiToken({ token: 'any-token' }, ctx);

            expect(result.organizationId).toBeUndefined();
            expect('organizationId' in result).toBe(false);
        });

        it('returns valid: false for a revoked token', async () => {
            const { ctx } = createMockContext({
                handlers: {
                    'identity.apiToken.find_one': async () => ({
                        userId: 'u-789',
                        organizationId: 'org-42',
                        roles: [],
                        name: 't',
                        revokedAt: new Date(Date.now() - 1000),
                    }),
                },
            });

            expect(await validateApiToken({ token: 'any-token' }, ctx)).toEqual({ valid: false });
        });
    });

    describe('validateTicket', () => {
        it('returns valid: true with userId and roles for an active unrevoked ticket', async () => {
            const activeTicket = {
                id: 'tick-1',
                token: 'tok-abc-123',
                userId: 'u-456',
                roles: ['operator', 'member'],
                issuedAt: new Date(Date.now() - 1000),
                expiresAt: new Date(Date.now() + 60000), // 1 minute in future
                revokedAt: undefined,
            };

            const { ctx } = createMockContext({
                handlers: {
                    'identity.ticket.find_one': async ({ query }) => {
                        if (query.token === 'tok-abc-123') return activeTicket;
                        return undefined;
                    },
                },
            });

            const result = await validateTicket({ token: 'tok-abc-123' }, ctx);

            expect(result).toEqual({
                valid: true,
                userId: 'u-456',
                roles: ['operator', 'member'],
            });
        });

        it('returns valid: false when ticket does not exist in store', async () => {
            const { ctx } = createMockContext({
                handlers: {
                    'identity.ticket.find_one': async () => undefined,
                },
            });

            const result = await validateTicket({ token: 'unknown-tok' }, ctx);

            expect(result).toEqual({ valid: false });
        });

        it('returns valid: false when ticket has expired', async () => {
            const expiredTicket = {
                id: 'tick-2',
                token: 'tok-expired',
                userId: 'u-456',
                roles: ['operator'],
                issuedAt: new Date(Date.now() - 100000),
                expiresAt: new Date(Date.now() - 1000), // 1 second in past
                revokedAt: undefined,
            };

            const { ctx } = createMockContext({
                handlers: {
                    'identity.ticket.find_one': async () => expiredTicket,
                },
            });

            const result = await validateTicket({ token: 'tok-expired' }, ctx);

            expect(result).toEqual({ valid: false });
        });

        it('returns valid: false when ticket has been revoked', async () => {
            const revokedTicket = {
                id: 'tick-3',
                token: 'tok-revoked',
                userId: 'u-456',
                roles: ['operator'],
                issuedAt: new Date(Date.now() - 10000),
                expiresAt: new Date(Date.now() + 60000),
                revokedAt: new Date(Date.now() - 5000), // revoked 5 seconds ago
                revokedReason: 'Security rotation',
            };

            const { ctx } = createMockContext({
                handlers: {
                    'identity.ticket.find_one': async () => revokedTicket,
                },
            });

            const result = await validateTicket({ token: 'tok-revoked' }, ctx);

            expect(result).toEqual({ valid: false });
        });

        it('returns valid: false when ticket is both expired and revoked', async () => {
            const bothTicket = {
                id: 'tick-4',
                token: 'tok-both',
                userId: 'u-456',
                roles: [],
                issuedAt: new Date(Date.now() - 200000),
                expiresAt: new Date(Date.now() - 100000),
                revokedAt: new Date(Date.now() - 50000),
            };

            const { ctx } = createMockContext({
                handlers: {
                    'identity.ticket.find_one': async () => bothTicket,
                },
            });

            const result = await validateTicket({ token: 'tok-both' }, ctx);

            expect(result).toEqual({ valid: false });
        });
    });

    describe('revokeTicket', () => {
        it('revokes a single ticket by token, emits event, and returns count', async () => {
            const activeTicket = {
                id: 'tick-1',
                token: 'tok-target',
                userId: 'u-1',
                revokedAt: undefined,
            };
            const updates: any[] = [];

            const { ctx, emitted } = createMockContext({
                handlers: {
                    'identity.ticket.find_one': async ({ query }) => {
                        if (query.token === 'tok-target') return activeTicket;
                        return undefined;
                    },
                    'identity.ticket.update': async (params) => {
                        updates.push(params);
                        return params;
                    },
                },
            });

            const result = await revokeTicket(
                { token: 'tok-target', reason: 'User requested logout' },
                ctx
            );

            expect(result.revoked).toBe(1);
            expect(result.epoch).toBeTypeOf('number');

            expect(updates).toHaveLength(1);
            expect(updates[0].id).toBe('tick-1');
            expect(updates[0].revokedAt).toBeInstanceOf(Date);
            expect(updates[0].revokedReason).toBe('User requested logout');

            expect(emitted).toHaveLength(1);
            expect(emitted[0]?.event).toBe('identity.ticket.revoked');
            expect(emitted[0]?.params).toEqual({
                id: 'tick-1',
                userId: 'u-1',
                tokenId: 'tok-target',
                revokedAt: result.epoch,
                revokedReason: 'User requested logout',
            });
        });

        it('revokes all active tickets for a userId, skipping already revoked ones', async () => {
            const userTickets = [
                { id: 'tick-a', token: 'tok-a', userId: 'u-10', revokedAt: undefined },
                { id: 'tick-b', token: 'tok-b', userId: 'u-10', revokedAt: new Date(Date.now() - 1000) }, // already revoked
                { id: 'tick-c', token: 'tok-c', userId: 'u-10', revokedAt: undefined },
            ];
            const updates: any[] = [];

            const { ctx, emitted } = createMockContext({
                handlers: {
                    'identity.ticket.find': async ({ query }) => {
                        if (query.userId === 'u-10') return userTickets;
                        return [];
                    },
                    'identity.ticket.update': async (params) => {
                        updates.push(params);
                        return params;
                    },
                },
            });

            const result = await revokeTicket(
                { userId: 'u-10', reason: 'Password reset' },
                ctx
            );

            expect(result.revoked).toBe(2);
            expect(updates).toHaveLength(2);
            expect(updates.map((u) => u.id)).toEqual(['tick-a', 'tick-c']);

            expect(emitted).toHaveLength(2);
            expect(emitted[0]?.params.id).toBe('tick-a');
            expect(emitted[1]?.params.id).toBe('tick-c');
        });

        it('does nothing and returns revoked: 0 when token is not found', async () => {
            const { ctx, calls, emitted } = createMockContext({
                handlers: {
                    'identity.ticket.find_one': async () => undefined,
                },
            });

            const result = await revokeTicket({ token: 'nonexistent' }, ctx);

            expect(result.revoked).toBe(0);
            expect(calls.some((c) => c.action === 'identity.ticket.update')).toBe(false);
            expect(emitted).toHaveLength(0);
        });

        it('skips already revoked ticket when revoking by token', async () => {
            const { ctx, calls, emitted } = createMockContext({
                handlers: {
                    'identity.ticket.find_one': async () => ({
                        id: 'tick-already',
                        token: 'tok-already',
                        userId: 'u-1',
                        revokedAt: new Date(),
                    }),
                },
            });

            const result = await revokeTicket({ token: 'tok-already' }, ctx);

            expect(result.revoked).toBe(0);
            expect(calls.some((c) => c.action === 'identity.ticket.update')).toBe(false);
            expect(emitted).toHaveLength(0);
        });

        it('handles case when neither token nor userId is provided', async () => {
            const { ctx, calls, emitted } = createMockContext();

            const result = await revokeTicket({}, ctx);

            expect(result.revoked).toBe(0);
            expect(calls).toHaveLength(0);
            expect(emitted).toHaveLength(0);
        });

        it('omits revokedReason when not provided in input', async () => {
            const activeTicket = {
                id: 'tick-no-reason',
                token: 'tok-no-reason',
                userId: 'u-1',
                revokedAt: undefined,
            };
            const updates: any[] = [];

            const { ctx, emitted } = createMockContext({
                handlers: {
                    'identity.ticket.find_one': async () => activeTicket,
                    'identity.ticket.update': async (params) => {
                        updates.push(params);
                        return params;
                    },
                },
            });

            const result = await revokeTicket({ token: 'tok-no-reason' }, ctx);

            expect(result.revoked).toBe(1);
            expect(updates[0]).not.toHaveProperty('revokedReason');
            expect(emitted[0]?.params.revokedReason).toBeUndefined();
        });
    });

    describe('signOut', () => {
        it('revokes active ticket and emits identity.user.signed_out event', async () => {
            const activeTicket = {
                id: 'tick-signout',
                token: 'tok-signout-1',
                userId: 'u-999',
                revokedAt: undefined,
            };
            const updates: any[] = [];

            const { ctx, emitted } = createMockContext({
                handlers: {
                    'identity.ticket.find_one': async ({ query }) => {
                        if (query.token === 'tok-signout-1') return activeTicket;
                        return undefined;
                    },
                    'identity.ticket.update': async (params) => {
                        updates.push(params);
                        return params;
                    },
                },
            });

            const result = await signOut({ token: 'tok-signout-1' }, ctx);

            expect(result).toEqual({ signedOut: true });

            expect(updates).toHaveLength(1);
            expect(updates[0].id).toBe('tick-signout');
            expect(updates[0].revokedAt).toBeInstanceOf(Date);

            expect(emitted).toHaveLength(1);
            expect(emitted[0]?.event).toBe('identity.user.signed_out');
            expect(emitted[0]?.params).toEqual({ userId: 'u-999' });
        });

        it('returns signedOut: true without updating or emitting if ticket is already revoked', async () => {
            const revokedTicket = {
                id: 'tick-already-revoked',
                token: 'tok-revoked-already',
                userId: 'u-999',
                revokedAt: new Date(),
            };

            const { ctx, calls, emitted } = createMockContext({
                handlers: {
                    'identity.ticket.find_one': async () => revokedTicket,
                },
            });

            const result = await signOut({ token: 'tok-revoked-already' }, ctx);

            expect(result).toEqual({ signedOut: true });
            expect(calls.some((c) => c.action === 'identity.ticket.update')).toBe(false);
            expect(emitted).toHaveLength(0);
        });

        it('returns signedOut: true without updating or emitting if ticket is not found', async () => {
            const { ctx, calls, emitted } = createMockContext({
                handlers: {
                    'identity.ticket.find_one': async () => undefined,
                },
            });

            const result = await signOut({ token: 'tok-missing' }, ctx);

            expect(result).toEqual({ signedOut: true });
            expect(calls.some((c) => c.action === 'identity.ticket.update')).toBe(false);
            expect(emitted).toHaveLength(0);
        });
    });
});
