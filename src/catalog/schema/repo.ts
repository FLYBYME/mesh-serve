import { z } from 'zod';

export const repoSchema = z.object({
  tenantId: z.string().describe('The organization that owns this repo'),
  url: z.string().describe('The git remote URL to clone or fetch from'),
  defaultBranch: z.string().default('main').describe('Branch a build uses when it does not name its own ref'),
  name: z.string().describe('The name of the repo'),
  credential: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/).optional()
    .describe('The name of the credential a build clones this repo with, resolved at build time through serve.credential.resolve -- a name, never the token. Absent: cloned with none (a public repo)'),
}).describe('A registered git repository parts are sourced from');
