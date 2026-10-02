import { defineContract, defineCrud, MeshError, z } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { membershipSchema } from '../schema/membership.js';

export const membershipCrud = defineCrud('identity.membership', membershipSchema, {
    // Flat, not nested under /organizations/:organizationId/ -- a nested path needs the client to
    // supply :organizationId as a same-named top-level input field (net/api.ts's fillPath), but
    // find/findOne/count/update/delete's generic CRUD input never carries the scope field at all
    // (only create's own row shape happens to). Tried nesting it once; it broke every read with
    // "needs organizationId and the input does not have it." The real scope is DatabaseMiddleware's
    // own resolved organizationId (api.service.ts's meta, aliasing the api's own tenant) regardless
    // of the URL, so nesting bought nothing anyway.
    pluralPath: 'memberships',
    // Scoped by the org, not the user: "who's in this organization" (an operator/roster view) is
    // the common, everyday access pattern and the one that needs DatabaseMiddleware's automatic
    // isolation -- you should never be able to query another org's roster by accident. "Which orgs
    // am I in" (identity.whoami) is the rare, narrow exception, and gets its own explicit raw lookup
    // instead (see whoami.ts) rather than forcing this collection to default to the less common case.
    scopedBy: 'organizationId',
    unique: [{ fields: 'userId', scope: 'scoped' }],
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public',
        create: 'public', update: 'public', delete: 'public',
    },
    hooks: {
        create: {
            // A membership cannot name an organization that doesn't exist. Declared here so it
            // holds wherever this collection is mounted, not wherever it happens to be registered.
            before: async (input: never, ctx: never) => {
                const record = input as unknown as { organizationId: string };
                const org = await (ctx as IServiceContext).db('identity.organization').resolve({ id: record.organizationId });
                if (org === undefined) {
                    throw new MeshError({ message: `No organization "${record.organizationId}".`, code: 'NOT_FOUND', status: 404 });
                }
                return record;
            },
        },
    },
    dependencies: ['identity.organization', 'identity.user'],
    filePath: 'src/identity/contracts/membership.contract.ts',
    permissions: [],
});

export type Membership = z.infer<typeof membershipCrud.outputSchema>;

export const membershipAssignInputSchema = z.object({
    userId: z.string().min(1).describe('The account'),
    organizationId: z.string().min(1).describe('The organization'),
    roleKey: z.string().min(1).nullable().describe('An organization-scoped role key (e.g. owner, member), or null to take the account out of the organization'),
}).describe('Put an account in an organization with a role, change its role, or take it out');

export const membershipAssignOutputSchema = z.object({
    userId: z.string(),
    organizationId: z.string(),
    roleKey: z.string().nullable().describe('The role afterwards; null when no longer a member'),
    changed: z.boolean(),
});

/**
 * The operator's way to manage any organization's people. membership.create/update cannot: the
 * collection is scoped by organization, and its CRUD writes into the *caller's* own organization
 * whatever the input says (organization.contract.ts tells that story). This writes with the named
 * organization's scope, explicitly. An organization always keeps an owner.
 */
export const membershipAssignContract = defineContract({
    domain: 'identity.membership',
    action: 'assign',
    description: 'Put an account in an organization with a role, change it, or remove it (roleKey null). An organization always keeps an owner.',
    inputSchema: membershipAssignInputSchema,
    outputSchema: membershipAssignOutputSchema,
    rest: { method: 'POST', path: '/identity/memberships/assign' },
    dependencies: ['identity.membership', 'identity.organization', 'identity.user', 'identity.role'],
    visibility: 'public',
    destructive: true,
    filePath: 'src/identity/tools/assignMembership.ts', concurrency: 'on-demand', permissions: ['operator'],
    print: (o) => `${o.userId} in ${o.organizationId}: ${o.roleKey ?? 'removed'}`,
});

export type MembershipAssignInput = z.infer<typeof membershipAssignInputSchema>;
export type MembershipAssignOutput = z.infer<typeof membershipAssignOutputSchema>;
