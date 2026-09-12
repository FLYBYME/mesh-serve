/**
 * Accounts, organizations, and the membership that joins them.
 *
 * `spec/identity.md` §1. Three collections and nothing else in this file — roles and grants arrive
 * with the contract rename (**C1**), and adding their rows before the names they refer to exist
 * would be a schema written against a hierarchy that is not there yet.
 */

import { z } from '@flybyme/mesh';

/**
 * A person or a machine that can hold a ticket.
 *
 * **`passwordHash` is the reason this whole collection is sealed today**, and the reason
 * `spec/questions.md` **A1** exists: every action is internal because one field must never leave, so
 * nothing on this platform can turn a user id into a name. When field-level visibility lands in
 * `defineCrud`, this is the first row to use it.
 */
export const UserSchema = z.object({
    email: z.string().email().describe('Unique across the deployment. What you sign in with'),
    displayName: z.string().min(1).describe('What a person is shown'),

    /** Optional: an account can exist before it has a credential. See `provisional`. */
    passwordHash: z.string().optional(),

    /**
     * Created by the platform because a cluster with no accounts cannot be signed into.
     *
     * Refused everywhere except `identity.set_password`, which clears it. Without that carve-out the
     * first boot produces a credential that can do nothing at all, including stop being provisional
     * — `spec/serving.md` §6.
     */
    provisional: z.boolean().optional(),

    /** Platform-wide roles. Roles held in one organization live on the membership. */
    roles: z.array(z.string()).default([]),

    suspendedAt: z.number().optional(),
    suspendedReason: z.string().optional(),
});

export type User = z.infer<typeof UserSchema>;

/** Who owns things: sites, repositories, parts. Not a group of permissions. */
export const OrganizationSchema = z.object({
    slug: z.string().min(1).describe('Stable, and what a URL or a header names'),
    name: z.string().min(1),
    ownerId: z.string().min(1).describe('The account that owns it. Transferable, one day — E1'),
});

export type Organization = z.infer<typeof OrganizationSchema>;

/**
 * An account's place in one organization.
 *
 * Scoped by `organizationId`, which is also the value the gate resolves and hands to every scoped
 * read. That it is called `organizationId` here and `tenantId` on a site is **B2**, and picking one
 * gets harder per collection written — so this one is written the way the answer will be.
 */
export const MembershipSchema = z.object({
    userId: z.string().min(1),
    organizationId: z.string().min(1),
    roleKey: z.string().min(1).describe('One role per membership, for now'),
    invitedBy: z.string().optional(),
    joinedAt: z.number(),
});

export type Membership = z.infer<typeof MembershipSchema>;
