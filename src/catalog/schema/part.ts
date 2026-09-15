import { z } from 'zod';

export const partSchema = z.object({
  tenantId: z.string().describe('The organization that owns this part'),
  repoId: z.string().describe('The serve.repo this part is built from'),
  key: z.string().describe('Namespaced "org-slug/part-name", e.g. "acme/blog-app" -- the identifier other records point at, e.g. site.open[].application'),
  kind: z.enum(['kernel', 'application', 'extension', 'driver', 'theme']).describe('Which of mesh-web\'s contribution kinds this part is; kernel is the boot bundle itself'),
  path: z.string().describe('Subdirectory within the repo this part is built from; "." means the repo root'),
  entryPoint: z.string().describe('The entry point of the part'),
  imports: z.string().optional().describe('The bare specifier other parts reach this one by, e.g. "@flybyme/mesh-core/ui" -- absent means nothing outside this part\'s own composition may import it (true of every application: a site composes one, code never imports it). Present on a part means the builder marks it external in every sibling build and the site\'s import map points it at this artifact'),
  wants: z.array(z.string()).default([]).describe('Contract keys this part calls, e.g. "identity.whoami" -- resolved from mesh.wants.json in the repo at build time, not hand-edited'),
  description: z.string().optional().describe('A human description of what this part does'),
}).describe('A buildable part of a kernel, Application, Extension, driver, or theme, sourced from one repo');
