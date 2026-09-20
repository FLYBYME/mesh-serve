import { defineCrud, MeshError, z } from '@flybyme/mesh';
import type { IServiceContext } from '@flybyme/mesh';

import { organizationSchema } from '../schema/organization.js';

export const organizationCrud = defineCrud('identity.organization', organizationSchema, {
    pluralPath: 'organizations',
    unique: [{ fields: 'slug', scope: 'global' }],
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public', create: 'public',
    },
    hooks: {
        create: {
            // An organization cannot be owned by an account that doesn't exist. Declared on the
            // collection so it holds wherever this collection is mounted, rather than depending on
            // a registration site remembering to pass it.
            before: async (input: never, ctx: never) => {
                const record = input as unknown as { ownerId: string };
                const owner = await (ctx as IServiceContext).db('identity.user').resolve({ id: record.ownerId });
                if (owner === undefined) {
                    throw new MeshError({ message: `No account "${record.ownerId}".`, code: 'NOT_FOUND', status: 404 });
                }
                return record;
            },
            // The owner's own membership, created here rather than left as a second call the
            // caller has to remember. `bootstrap.ts` already does exactly this by hand (create
            // user, create org, create membership) for the one organization it is allowed to
            // create directly; every other organization -- onboarded live, through the api -- has
            // no equivalent, because `identity.membership.create` cannot do it itself. Its own
            // collection is `scopedBy: 'organizationId'`, and `CrudExecutor`'s create path
            // unconditionally overwrites that field with the *caller's own* resolved scope
            // (deliberately -- it is what stops an ordinary caller writing into someone else's
            // tenant) -- so an operator's own `organizationId` in the request body was silently
            // discarded and the membership landed in the operator's own org instead. Found live,
            // seeding a second tenant to prove real cross-tenant isolation. This hook runs with
            // the new organization's own id already in hand, inside the same create this account
            // is legitimately allowed to make -- the org row and its owner's membership come into
            // existence atomically, and nothing has to be silently coerced to get there.
            //
            // The explicit `meta` override is required, not incidental: `ctx.db()` without one
            // resolves the *caller's own* scope, same as the bug this hook exists to route around
            // -- shallow-merging a whole `user` object naming the new org is `ctx.db`'s own
            // documented shape for "this handler genuinely needs a different scope than its own
            // caller's" (IServiceContext.ts), the same pattern api/gateway.ts's checkGate already
            // uses for an identity.hasRole check against an arbitrary target org.
            after: async (output: never, ctx: never) => {
                const org = output as unknown as { id: string; ownerId: string };
                const serviceCtx = ctx as IServiceContext;
                await serviceCtx.db('identity.membership', { user: { id: org.ownerId, tenant_id: org.id, organizationId: org.id } }).create({
                    userId: org.ownerId,
                    organizationId: org.id,
                    roleKey: 'owner',
                    joinedAt: new Date(),
                });
                return output;
            },
        },
    },
    dependencies: ['identity.user', 'identity.membership'],
    filePath: 'src/identity/contracts/organization.contract.ts',
    permissions: [],
});

export type Organization = z.infer<typeof organizationCrud.outputSchema>;
