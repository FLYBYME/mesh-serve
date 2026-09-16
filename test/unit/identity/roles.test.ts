import { describe, expect, it } from 'vitest';
import { matchesContract, resolveEffectiveRoleKeys, expandRoles } from '../../../src/identity/methods/roles.js';
import { createMockContext } from '../helpers/mockContext.js';

describe('roles method utilities', () => {
    describe('matchesContract', () => {
        describe('exact match', () => {
            it('matches identical full contract strings', () => {
                expect(matchesContract('identity.user.create', 'identity.user.create')).toBe(true);
                expect(matchesContract('serve.expose.create', 'serve.expose.create')).toBe(true);
            });

            it('matches identical wildcard-syntax strings', () => {
                expect(matchesContract('identity.*', 'identity.*')).toBe(true);
            });

            it('matches single-segment identical names', () => {
                expect(matchesContract('login', 'login')).toBe(true);
            });
        });

        describe('wildcard domain.*', () => {
            it('matches any action in domain when pattern ends with .*', () => {
                expect(matchesContract('identity.*', 'identity.user.create')).toBe(true);
                expect(matchesContract('identity.*', 'identity.membership.find_one')).toBe(true);
                expect(matchesContract('serve.*', 'serve.expose.create')).toBe(true);
            });

            it('matches multi-segment hierarchical domains', () => {
                expect(matchesContract('identity.user.*', 'identity.user.create')).toBe(true);
                expect(matchesContract('identity.user.*', 'identity.user.resolve')).toBe(true);
                expect(matchesContract('org.team.service.*', 'org.team.service.action.create')).toBe(true);
            });
        });

        describe('prefix edge cases', () => {
            it('does not match bare domain without trailing dot', () => {
                // 'identity.*' requires contract to start with 'identity.'
                expect(matchesContract('identity.*', 'identity')).toBe(false);
            });

            it('does not match contracts where domain is just a prefix of another word', () => {
                // 'identity.*' should not match 'identity_audit.view' or 'identityuser.create'
                expect(matchesContract('identity.*', 'identity_audit.view')).toBe(false);
                expect(matchesContract('identity.*', 'identityuser.create')).toBe(false);
            });

            it('does not treat wildcards without dot as wildcards', () => {
                // 'identity*' does not end with '.*'
                expect(matchesContract('identity*', 'identity.user.create')).toBe(false);
            });

            it('does not treat bare * as matching everything', () => {
                // '*' does not end with '.*'
                expect(matchesContract('*', 'identity.user.create')).toBe(false);
                expect(matchesContract('*', '*')).toBe(true); // exact match
            });

            it('does not treat wildcard in the middle as a glob', () => {
                // 'identity.*.create' does not end with '.*'
                expect(matchesContract('identity.*.create', 'identity.user.create')).toBe(false);
            });

            it('handles leading dot wildcard (.*)', () => {
                expect(matchesContract('.*', '.foo')).toBe(true);
                expect(matchesContract('.*', 'foo')).toBe(false);
            });
        });

        describe('non-matches', () => {
            it('rejects completely different domains', () => {
                expect(matchesContract('identity.*', 'serve.expose.create')).toBe(false);
                expect(matchesContract('catalog.*', 'identity.user.resolve')).toBe(false);
            });

            it('rejects different actions within same domain without wildcard', () => {
                expect(matchesContract('identity.user.create', 'identity.user.update')).toBe(false);
            });

            it('rejects when pattern is longer than contract', () => {
                expect(matchesContract('identity.user.create.deep', 'identity.user.create')).toBe(false);
            });

            it('rejects empty strings unless both are empty', () => {
                expect(matchesContract('', 'identity.user.create')).toBe(false);
                expect(matchesContract('identity.*', '')).toBe(false);
                expect(matchesContract('', '')).toBe(true);
            });

            it('rejects reverse matching (exact pattern does not match wildcard contract)', () => {
                expect(matchesContract('identity.user.create', 'identity.*')).toBe(false);
            });
        });
    });

    describe('resolveEffectiveRoleKeys', () => {
        it('resolves only global account roles when organizationId is undefined', async () => {
            const { ctx, calls } = createMockContext({
                handlers: {
                    'identity.user.resolve': async ({ id }) => {
                        if (id === 'user-1') {
                            return { id: 'user-1', roles: ['operator', 'developer'] };
                        }
                        return undefined;
                    },
                },
            });

            const roles = await resolveEffectiveRoleKeys('user-1', undefined, ctx);

            expect(roles).toEqual(new Set(['operator', 'developer']));
            expect(calls).toHaveLength(1);
            expect(calls[0]).toEqual({
                action: 'identity.user.resolve',
                params: { id: 'user-1' },
                options: undefined,
            });
        });

        it('returns empty set if user is not found', async () => {
            const { ctx } = createMockContext({
                handlers: {
                    'identity.user.resolve': async () => undefined,
                },
            });

            const roles = await resolveEffectiveRoleKeys('non-existent', undefined, ctx);
            expect(roles).toEqual(new Set());
        });

        it('handles user with undefined or empty roles', async () => {
            const { ctx } = createMockContext({
                handlers: {
                    'identity.user.resolve': async () => ({ id: 'user-2', roles: undefined }),
                },
            });

            const roles = await resolveEffectiveRoleKeys('user-2', undefined, ctx);
            expect(roles).toEqual(new Set());
        });

        it('combines global account roles with organization-scoped membership roles', async () => {
            const { ctx, calls } = createMockContext({
                handlers: {
                    'identity.user.resolve': async ({ id }) => ({
                        id,
                        roles: ['developer'],
                    }),
                    'identity.membership.find_one': async ({ query }) => {
                        if (query.userId === 'user-1' && query.organizationId === 'org-1') {
                            return { id: 'mem-1', userId: 'user-1', organizationId: 'org-1', roleKey: 'owner' };
                        }
                        return undefined;
                    },
                    'identity.role.find_one': async ({ query }) => {
                        if (query.key === 'owner') {
                            return { key: 'owner', name: 'Owner', scope: 'organization', inherits: [], permissions: [] };
                        }
                        return undefined;
                    },
                },
            });

            const roles = await resolveEffectiveRoleKeys('user-1', 'org-1', ctx);

            expect(roles).toEqual(new Set(['developer', 'owner']));
            expect(calls).toHaveLength(3);
            expect(calls[0]?.action).toBe('identity.user.resolve');
            expect(calls[1]?.action).toBe('identity.membership.find_one');
            expect(calls[1]?.params).toEqual({ query: { userId: 'user-1', organizationId: 'org-1' } });
            expect(calls[2]?.action).toBe('identity.role.find_one');
            expect(calls[2]?.params).toEqual({ query: { key: 'owner' } });
        });

        it('ignores membership role if its scope is global', async () => {
            const { ctx } = createMockContext({
                handlers: {
                    'identity.user.resolve': async ({ id }) => ({
                        id,
                        roles: ['viewer'],
                    }),
                    'identity.membership.find_one': async () => ({
                        id: 'mem-2',
                        userId: 'user-1',
                        organizationId: 'org-1',
                        roleKey: 'rogue-operator',
                    }),
                    'identity.role.find_one': async ({ query }) => {
                        if (query.key === 'rogue-operator') {
                            // Organization row attempted to assign a global scope role!
                            return { key: 'rogue-operator', name: 'Rogue Operator', scope: 'global', inherits: [], permissions: ['*'] };
                        }
                        return undefined;
                    },
                },
            });

            const roles = await resolveEffectiveRoleKeys('user-1', 'org-1', ctx);

            // 'rogue-operator' must NOT be added
            expect(roles).toEqual(new Set(['viewer']));
        });

        it('returns only global roles when membership is not found for organization', async () => {
            const { ctx, calls } = createMockContext({
                handlers: {
                    'identity.user.resolve': async ({ id }) => ({ id, roles: ['member'] }),
                    'identity.membership.find_one': async () => undefined,
                },
            });

            const roles = await resolveEffectiveRoleKeys('user-1', 'unknown-org', ctx);

            expect(roles).toEqual(new Set(['member']));
            // role.find_one should not be called if membership not found
            expect(calls.some((c) => c.action === 'identity.role.find_one')).toBe(false);
        });

        it('returns only global roles when role document for membership roleKey is not found', async () => {
            const { ctx } = createMockContext({
                handlers: {
                    'identity.user.resolve': async ({ id }) => ({ id, roles: ['member'] }),
                    'identity.membership.find_one': async () => ({
                        id: 'mem-3',
                        userId: 'user-1',
                        organizationId: 'org-1',
                        roleKey: 'deleted-role',
                    }),
                    'identity.role.find_one': async () => undefined,
                },
            });

            const roles = await resolveEffectiveRoleKeys('user-1', 'org-1', ctx);

            expect(roles).toEqual(new Set(['member']));
        });

        it('deduplicates role if user holds it globally and via membership', async () => {
            const { ctx } = createMockContext({
                handlers: {
                    'identity.user.resolve': async ({ id }) => ({ id, roles: ['custom-role'] }),
                    'identity.membership.find_one': async () => ({
                        id: 'mem-4',
                        userId: 'user-1',
                        organizationId: 'org-1',
                        roleKey: 'custom-role',
                    }),
                    'identity.role.find_one': async () => ({
                        key: 'custom-role',
                        scope: 'organization',
                        inherits: [],
                        permissions: [],
                    }),
                },
            });

            const roles = await resolveEffectiveRoleKeys('user-1', 'org-1', ctx);

            expect(roles.size).toBe(1);
            expect(roles.has('custom-role')).toBe(true);
        });
    });

    describe('expandRoles', () => {
        it('returns empty map when roleKeys is empty', async () => {
            const { ctx, calls } = createMockContext({
                handlers: {
                    'identity.role.find': async () => [],
                },
            });

            const result = await expandRoles(new Set(), ctx);

            expect(result.size).toBe(0);
            expect(calls).toHaveLength(1);
            expect(calls[0]?.action).toBe('identity.role.find');
        });

        it('resolves a single role without inheritance', async () => {
            const rolesDb = [
                { key: 'viewer', permissions: ['identity.user.resolve'], inherits: [] },
                { key: 'admin', permissions: ['identity.*'], inherits: [] },
            ];
            const { ctx } = createMockContext({
                handlers: {
                    'identity.role.find': async () => rolesDb,
                },
            });

            const result = await expandRoles(new Set(['viewer']), ctx);

            expect(result.size).toBe(1);
            expect(result.get('viewer')).toEqual(['identity.user.resolve']);
        });

        it('expands linear inheritance chain (admin -> editor -> viewer)', async () => {
            const rolesDb = [
                { key: 'viewer', permissions: ['serve.repo.get'], inherits: [] },
                { key: 'editor', permissions: ['serve.repo.update'], inherits: ['viewer'] },
                { key: 'admin', permissions: ['serve.repo.delete'], inherits: ['editor'] },
            ];
            const { ctx } = createMockContext({
                handlers: {
                    'identity.role.find': async () => rolesDb,
                },
            });

            const result = await expandRoles(new Set(['admin']), ctx);

            expect(result.size).toBe(3);
            expect(result.get('admin')).toEqual(['serve.repo.delete']);
            expect(result.get('editor')).toEqual(['serve.repo.update']);
            expect(result.get('viewer')).toEqual(['serve.repo.get']);
        });

        it('expands branching multiple inheritance (lead -> [developer, reviewer])', async () => {
            const rolesDb = [
                { key: 'developer', permissions: ['serve.part.create'], inherits: [] },
                { key: 'reviewer', permissions: ['serve.part.inspect'], inherits: [] },
                { key: 'lead', permissions: ['serve.part.release'], inherits: ['developer', 'reviewer'] },
            ];
            const { ctx } = createMockContext({
                handlers: {
                    'identity.role.find': async () => rolesDb,
                },
            });

            const result = await expandRoles(new Set(['lead']), ctx);

            expect(result.size).toBe(3);
            expect(result.has('lead')).toBe(true);
            expect(result.has('developer')).toBe(true);
            expect(result.has('reviewer')).toBe(true);
            expect(result.get('lead')).toEqual(['serve.part.release']);
            expect(result.get('developer')).toEqual(['serve.part.create']);
            expect(result.get('reviewer')).toEqual(['serve.part.inspect']);
        });

        it('expands multiple starting roleKeys', async () => {
            const rolesDb = [
                { key: 'roleA', permissions: ['permA'], inherits: [] },
                { key: 'roleB', permissions: ['permB'], inherits: [] },
            ];
            const { ctx } = createMockContext({
                handlers: {
                    'identity.role.find': async () => rolesDb,
                },
            });

            const result = await expandRoles(new Set(['roleA', 'roleB']), ctx);

            expect(result.size).toBe(2);
            expect(result.get('roleA')).toEqual(['permA']);
            expect(result.get('roleB')).toEqual(['permB']);
        });

        describe('circular inheritance handling', () => {
            it('terminates cleanly on direct 2-node cycle (A -> B -> A)', async () => {
                const rolesDb = [
                    { key: 'A', permissions: ['permA'], inherits: ['B'] },
                    { key: 'B', permissions: ['permB'], inherits: ['A'] },
                ];
                const { ctx } = createMockContext({
                    handlers: {
                        'identity.role.find': async () => rolesDb,
                    },
                });

                const result = await expandRoles(new Set(['A']), ctx);

                expect(result.size).toBe(2);
                expect(result.get('A')).toEqual(['permA']);
                expect(result.get('B')).toEqual(['permB']);
            });

            it('terminates cleanly on self-inheritance (A -> A)', async () => {
                const rolesDb = [
                    { key: 'A', permissions: ['permA'], inherits: ['A'] },
                ];
                const { ctx } = createMockContext({
                    handlers: {
                        'identity.role.find': async () => rolesDb,
                    },
                });

                const result = await expandRoles(new Set(['A']), ctx);

                expect(result.size).toBe(1);
                expect(result.get('A')).toEqual(['permA']);
            });

            it('terminates cleanly on multi-node cycle (A -> B -> C -> A)', async () => {
                const rolesDb = [
                    { key: 'A', permissions: ['permA'], inherits: ['B'] },
                    { key: 'B', permissions: ['permB'], inherits: ['C'] },
                    { key: 'C', permissions: ['permC'], inherits: ['A'] },
                ];
                const { ctx } = createMockContext({
                    handlers: {
                        'identity.role.find': async () => rolesDb,
                    },
                });

                const result = await expandRoles(new Set(['A']), ctx);

                expect(result.size).toBe(3);
                expect(result.has('A')).toBe(true);
                expect(result.has('B')).toBe(true);
                expect(result.has('C')).toBe(true);
            });

            it('handles diamond inheritance without infinite loops or duplicates (A -> B, C -> D)', async () => {
                const rolesDb = [
                    { key: 'D', permissions: ['permD'], inherits: [] },
                    { key: 'B', permissions: ['permB'], inherits: ['D'] },
                    { key: 'C', permissions: ['permC'], inherits: ['D'] },
                    { key: 'A', permissions: ['permA'], inherits: ['B', 'C'] },
                ];
                const { ctx } = createMockContext({
                    handlers: {
                        'identity.role.find': async () => rolesDb,
                    },
                });

                const result = await expandRoles(new Set(['A']), ctx);

                expect(result.size).toBe(4);
                expect(result.get('D')).toEqual(['permD']);
            });
        });

        describe('edge cases', () => {
            it('records missing role with empty permissions array', async () => {
                const rolesDb = [
                    { key: 'existing', permissions: ['perm1'], inherits: [] },
                ];
                const { ctx } = createMockContext({
                    handlers: {
                        'identity.role.find': async () => rolesDb,
                    },
                });

                const result = await expandRoles(new Set(['existing', 'non-existent']), ctx);

                expect(result.size).toBe(2);
                expect(result.get('existing')).toEqual(['perm1']);
                expect(result.get('non-existent')).toEqual([]);
            });

            it('records unseeded inherited role with empty permissions array', async () => {
                const rolesDb = [
                    { key: 'admin', permissions: ['perm1'], inherits: ['unseeded-base'] },
                ];
                const { ctx } = createMockContext({
                    handlers: {
                        'identity.role.find': async () => rolesDb,
                    },
                });

                const result = await expandRoles(new Set(['admin']), ctx);

                expect(result.size).toBe(2);
                expect(result.get('admin')).toEqual(['perm1']);
                expect(result.get('unseeded-base')).toEqual([]);
            });

            it('defaults undefined permissions on a role document to empty array', async () => {
                const rolesDb = [
                    { key: 'no-perms', permissions: undefined as unknown as string[], inherits: [] },
                ];
                const { ctx } = createMockContext({
                    handlers: {
                        'identity.role.find': async () => rolesDb,
                    },
                });

                const result = await expandRoles(new Set(['no-perms']), ctx);

                expect(result.size).toBe(1);
                expect(result.get('no-perms')).toEqual([]);
            });
        });
    });
});
