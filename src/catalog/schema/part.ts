import { z } from 'zod';

export const partKindSchema = z.enum(['kernel', 'application', 'extension', 'driver', 'theme', 'service']).describe('Which of mesh-web\'s contribution kinds this part is (kernel is the boot bundle itself), or "service": mesh contracts and their handlers bundled for node instead of the browser, loaded into a running node by serve.part.start rather than composed into a site');

export const partSchema = z.object({
  tenantId: z.string().describe('The organization that owns this part'),
  repoId: z.string().describe('The serve.repo this part is built from'),
  key: z.string().describe('Namespaced "org-slug/part-name", e.g. "acme/blog-app" -- the identifier other records point at, e.g. site.open[].application'),
  kind: partKindSchema,
  path: z.string().describe('Subdirectory within the repo this part is built from; "." means the repo root'),
  entryPoint: z.string().describe('The entry point of the part'),
  imports: z.string().optional().describe('The bare specifier other parts reach this one by, e.g. "@flybyme/mesh-core/ui" -- absent means nothing outside this part\'s own composition may import it (true of every application: a site composes one, code never imports it). Present on a part means the builder marks it external in every sibling build and the site\'s import map points it at this artifact'),
  wants: z.array(z.string()).default([]).describe('Contract keys this part calls, e.g. "identity.whoami" -- resolved from mesh.wants.json in the repo at build time, not hand-edited'),
  description: z.string().optional().describe('A human description of what this part does'),
  options: z.record(z.string(), z.unknown()).optional().describe('Passed to this part\'s constructor as its PartRef.options (mesh-web kernel/start.ts) -- the site\'s decision, never the part\'s. Must be JSON-serializable: it is baked into the generated boot module as a literal, not handed a live object (a ticket store, say) at runtime'),
  desired: z.enum(['running', 'stopped']).default('stopped').describe('Whether this service should be running *somewhere* in the cluster -- the declarative half, only meaningful for kind: "service". serve.part.reconcile compares it against what nodes actually report and starts or stops to close the gap. serve.part.start/stop stay imperative and do not change it, so a hand-started service is not supervised until something sets this'),
}).describe('A buildable part of a kernel, Application, Extension, driver, or theme, sourced from one repo');
