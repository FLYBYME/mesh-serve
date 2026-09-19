import { defineCrud, z } from '@flybyme/mesh';

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
    dependencies: ['identity.organization', 'identity.user'],
    filePath: 'src/identity/contracts/membership.contract.ts',
    permissions: [],
});

export type Membership = z.infer<typeof membershipCrud.outputSchema>;
