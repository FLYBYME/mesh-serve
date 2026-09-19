import { z } from 'zod';

export const repoSchema = z.object({
  tenantId: z.string().describe('The organization that owns this repo'),
  url: z.string().describe('The git remote URL to clone or fetch from'),
  defaultBranch: z.string().default('main').describe('Branch a build uses when it does not name its own ref'),
  name: z.string().describe('The name of the repo'),
}).describe('A registered git repository parts are sourced from');
