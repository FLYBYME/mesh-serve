import { defineCrud, z } from '@flybyme/mesh';

import { repoSchema } from '../schema/repo.js';

export const repoCrud = defineCrud('serve.repo', repoSchema, {
    // Not `repos`: that is the gitserver's repo CRUD (surfdns-repo), exposed on the same apis, and
    // the two collided -- GET /api/repos answered with gitserver repos. These are the git remotes
    // parts are built from.
    pluralPath: 'sourceRepos',
    scopedBy: 'tenantId',
    unique: [{ fields: 'url', scope: 'scoped' }],
    // update: `mesh-serve init -c` reconciles a repo's declared defaultBranch against what's
    // already there on a rerun -- found live changing one in a config and the existing row
    // silently keeping its old value, since `create` alone only ever covers a genuinely new url.
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public', create: 'public', update: 'public',
    },
    dependencies: [],
    filePath: 'src/catalog/contracts/repo.contract.ts',
    permissions: [],
});

export type Repo = z.infer<typeof repoCrud.outputSchema>;
