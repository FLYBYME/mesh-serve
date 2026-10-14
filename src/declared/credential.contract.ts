import { defineContract, defaultPrint, z } from '@flybyme/mesh';

/**
 * The token a build clones a private repository with: asked at build time, by the credential's name
 * on the repo (`serve.repo.credential`), never kept in the builder's environment (owner, 10-14).
 *
 * Declared here and **implemented elsewhere**: mesh-serve keeps no secrets. A platform registers a
 * handler for it from wherever it keeps them (SurfDNS: surfdns-certs, from the vault). With none
 * registered, a repo that names a credential fails its build saying so, and a repo that names none
 * builds as it always has.
 */
export const credentialResolveContract = defineContract({
    domain: 'serve.credential',
    action: 'resolve',
    description: 'The token to clone one repository with, by the credential name its serve.repo record carries.',
    inputSchema: z.object({
        tenantId: z.string().min(1).describe('The organization that owns the repo: the credential is looked up there'),
        name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/).describe('The credential\'s name, from serve.repo.credential'),
        url: z.string().min(1).describe('The repository it is for, so a provider can refuse a credential named for another host'),
    }),
    outputSchema: z.object({ token: z.string().min(1) }),
    rest: { method: 'POST', path: '/credentials/resolve' },
    destructive: false,
    // Never on an api: only a build, inside the mesh, asks.
    visibility: 'internal',
    // Implemented elsewhere (src/declared/: contracts mesh-serve declares and a platform answers).
    filePath: 'src/declared/credential.contract.ts',
    concurrency: 'on-demand',
    permissions: [],
    print: defaultPrint,
});

export type CredentialResolveInput = z.infer<typeof credentialResolveContract.inputSchema>;
export type CredentialResolveOutput = z.infer<typeof credentialResolveContract.outputSchema>;
