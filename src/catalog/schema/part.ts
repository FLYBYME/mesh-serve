import { z } from 'zod';

export const partSchema = z.object({
  tenantId: z.string().describe('The organization that owns this part'),
  repoId: z.string().describe('The serve.repo this part is built from'),
  key: z.string().describe('The identifier other records point at, e.g. site.open[].application'),
  kind: z.enum(['kernel', 'application', 'extension', 'driver', 'theme']).describe('Which of mesh-web\'s contribution kinds this part is; kernel is the boot bundle itself'),
  path: z.string().describe('Subdirectory within the repo this part is built from; "." means the repo root'),
  entryPoint: z.string().describe('The entry point of the part'),
  description: z.string().optional().describe('A human description of what this part does'),
}).describe('A buildable part of a kernel, Application, Extension, driver, or theme, sourced from one repo');
