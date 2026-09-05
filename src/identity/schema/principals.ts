/**
 * Who a caller is, and which organization they are acting in.
 *
 * mesh-web spec/auth.md §4 and §6. Three shapes and one join, and the join is the whole model:
 *
 *     user ──< membership >── organization
 *                  │
 *                roleKey
 *
 * **One `organizationId` per record, no ACL array.** A resource belongs to exactly one organization
 * and membership decides who reaches it. An array of principals on every row is the design that
 * cannot answer "what can this person see" without scanning everything, and cannot revoke without
 * finding every row that names them.
 */

import { z } from 'zod';

export const UserSchema = z.object({
    email: z.string().email(),
    displayName: z.string().min(1),
    /**
     * Absent for a user who only ever signs in with a passkey.
     *
     * Optional rather than a separate collection, because "has a password" is a fact about a person
     * and not a different kind of person — and a passkey-only account is the direction, not the
     * exception (auth §4).
     */
    passwordHash: z.string().optional(),
    /**
     * Cluster-scoped roles, held everywhere in this deployment.
     *
     * Organization roles are *not* here — they live on the membership, because they are a fact
     * about that pairing. Putting both in one list is how `admin` came to mean two things.
     */
    roles: z.array(z.string()).default([]),
    /** A suspended principal fails validation regardless of any live ticket. */
    suspendedAt: z.number().optional(),
    suspendedReason: z.string().optional(),
});

export type User = z.infer<typeof UserSchema>;

export const OrganizationSchema = z.object({
    slug: z.string().min(1).describe('Stable, and what a URL or a header names'),
    name: z.string().min(1),
    /**
     * Who can re-own it if the last owner leaves.
     *
     * surfdns #29: an organization whose owner leaves cannot be re-owned. Recorded as a field rather
     * than inferred from memberships so the answer is always available, including when there are no
     * owners left — which is exactly the case that broke.
     */
    ownerId: z.string().min(1),
});

export type Organization = z.infer<typeof OrganizationSchema>;

/**
 * A person's place in an organization.
 *
 * The join, and the only thing that grants organization-scoped anything. A role named here must be
 * a role whose scope is `organization` — a cluster role on a membership would be a second way to
 * become an operator, which is the ambiguity #26 is about.
 */
export const MembershipSchema = z.object({
    userId: z.string().min(1),
    organizationId: z.string().min(1),
    roleKey: z.string().min(1),
    invitedBy: z.string().optional(),
    joinedAt: z.number(),
});

export type Membership = z.infer<typeof MembershipSchema>;

/**
 * A long-lived credential a machine holds.
 *
 * Fine to hold *precisely because it is revocable* (auth §4) — which is the same reason tickets are
 * opaque. It resolves to a principal and a scope, so a token is never a way to be more than the
 * person who issued it.
 */
export const ApiTokenSchema = z.object({
    /** Shown once, at creation. Stored hashed: unlike a ticket, nobody needs to read this back. */
    tokenHash: z.string().min(1),
    name: z.string().min(1).describe('What it is for, so revoking the right one is possible'),
    userId: z.string().min(1),
    organizationId: z.string().optional(),
    roles: z.array(z.string()).default([]),
    createdAt: z.number(),
    lastUsedAt: z.number().optional(),
    expiresAt: z.number().optional(),
    revokedAt: z.number().optional(),
});

export type ApiToken = z.infer<typeof ApiTokenSchema>;

/**
 * Which organization is this caller acting in, and may they?
 *
 * The rules surfdns got right, kept: a caller in exactly one organization is unambiguous; a caller
 * in several **must name one**, because guessing on their behalf is how data is read from the wrong
 * place silently; and an organization that exists but is not theirs answers **not found**, because
 * "it exists, but not for you" is itself a disclosure.
 */
export type ScopeResolution =
    | { readonly ok: true; readonly organizationId: string; readonly roleKey: string }
    | { readonly ok: false; readonly code: 'NO_ORGANIZATION' | 'SCOPE_REQUIRED' | 'NOT_FOUND'; readonly message: string };

export function resolveScope(
    memberships: readonly Membership[],
    requested: string | undefined,
): ScopeResolution {
    if (memberships.length === 0) {
        return { ok: false, code: 'NO_ORGANIZATION', message: 'You belong to no organization.' };
    }

    if (requested === undefined) {
        if (memberships.length === 1) {
            const only = memberships[0]!;
            return { ok: true, organizationId: only.organizationId, roleKey: only.roleKey };
        }
        return {
            ok: false,
            code: 'SCOPE_REQUIRED',
            message: `You belong to ${String(memberships.length)} organizations. Name one.`,
        };
    }

    const chosen = memberships.find((m) => m.organizationId === requested);
    if (chosen === undefined) {
        return { ok: false, code: 'NOT_FOUND', message: 'No such organization.' };
    }

    return { ok: true, organizationId: chosen.organizationId, roleKey: chosen.roleKey };
}
