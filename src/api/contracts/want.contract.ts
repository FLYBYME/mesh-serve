import { defineCrud, z } from '@flybyme/mesh';

import { wantSchema } from '../schema/want.js';

export const wantCrud = defineCrud('serve.want', wantSchema, {
    pluralPath: 'wants',
    scopedBy: 'tenantId',
    unique: [{ fields: ['siteId', 'contract'], scope: 'scoped' }],
    // Reads only -- wants are derived from a part's own mesh.wants.json at build time, never
    // hand-written, so create/update/delete stay internal. Same gap as expose/artifact had
    // (visibility: {} meant nothing here was reachable over HTTP at all) -- found live exposing
    // this for the operator console's wants-vs-exposed panel.
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public',
    },
    dependencies: ['serve.site'],
    filePath: 'src/api/contracts/want.contract.ts',
    permissions: [],
});

export type Want = z.infer<typeof wantCrud.outputSchema>;
