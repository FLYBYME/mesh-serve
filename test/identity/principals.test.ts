/**
 * Scope resolution — mesh-web spec/auth.md §6, roadmap C1.7.
 *
 * These rules were right in surfdns and are kept deliberately. Each one is a decision about what to
 * do when the answer is ambiguous, and each has a failure mode that is silent if you get it wrong.
 */

import { describe, expect, it } from 'vitest';

import { MembershipSchema, OrganizationSchema, UserSchema, resolveScope, type Membership } from '../../src/identity/index.js';

const member = (organizationId: string, roleKey = 'member'): Membership => ({
    userId: 'u-alice',
    organizationId,
    roleKey,
    joinedAt: 0,
});

describe('which organization is this caller acting in', () => {
    it('is unambiguous for someone in exactly one', () => {
        expect(resolveScope([member('org-a')], undefined)).toEqual({
            ok: true, organizationId: 'org-a', roleKey: 'member',
        });
    });

    it('makes someone in several name one', () => {
        // Guessing on their behalf is how a request reads the wrong organization's data, and the
        // wrong answer is a perfectly valid-looking one.
        const resolved = resolveScope([member('org-a'), member('org-b')], undefined);

        expect(resolved.ok).toBe(false);
        if (resolved.ok) return;
        expect(resolved.code).toBe('SCOPE_REQUIRED');
        expect(resolved.message).toContain('2 organizations');
    });

    it('answers not-found for one that exists but is not theirs', () => {
        // 404 rather than 403: "it exists, but not for you" is itself a disclosure, and to the
        // caller it is indistinguishable from it not existing.
        const resolved = resolveScope([member('org-a')], 'org-someone-elses');

        expect(resolved.ok).toBe(false);
        if (resolved.ok) return;
        expect(resolved.code).toBe('NOT_FOUND');
    });

    it('carries the role from the membership, not from the user', () => {
        // The role is a fact about the *pairing*. A cluster role on a membership would be a second
        // way to become an operator, which is the ambiguity #26 is about.
        const resolved = resolveScope([member('org-a', 'owner'), member('org-b', 'reader')], 'org-b');

        expect(resolved.ok).toBe(true);
        if (!resolved.ok) return;
        expect(resolved.roleKey).toBe('reader');
    });

    it('says so when someone belongs nowhere', () => {
        const resolved = resolveScope([], undefined);
        expect(resolved.ok).toBe(false);
        if (resolved.ok) return;
        expect(resolved.code).toBe('NO_ORGANIZATION');
    });
});

describe('the shapes', () => {
    it('lets a user have no password, because a passkey account has none', () => {
        const parsed = UserSchema.safeParse({ email: 'a@b.com', displayName: 'A' });
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.roles).toEqual([]);
    });

    it('keeps cluster roles on the user and organization roles on the membership', () => {
        // Two lists, deliberately. One list is how `admin` came to mean two things.
        expect(Object.keys(MembershipSchema.shape)).toContain('roleKey');
        expect(Object.keys(UserSchema.shape)).toContain('roles');
        expect(Object.keys(MembershipSchema.shape)).not.toContain('roles');
    });

    it('gives an organization an owner, so #29 has an answer', () => {
        // surfdns #29: an organization whose owner leaves cannot be re-owned. A field rather than an
        // inference from memberships, so the answer exists even when no owners are left — which is
        // exactly the case that broke.
        expect(OrganizationSchema.safeParse({ slug: 'acme', name: 'Acme' }).success).toBe(false);
        expect(OrganizationSchema.safeParse({ slug: 'acme', name: 'Acme', ownerId: 'u-1' }).success).toBe(true);
    });
});
