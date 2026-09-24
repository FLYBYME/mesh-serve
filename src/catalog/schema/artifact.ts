import { z } from 'zod';

export const artifactAssetSchema = z.object({
  url: z.string().describe('Where this asset lives under /assets/:artifactHash/, relative to the artifact, e.g. "main.a1b2c3.js"'),
  name: z.string().describe('Filename, for Content-Disposition and display'),
  fileExtension: z.string().optional().describe('Lowercased extension including the dot, e.g. ".css"; used to pick out CSS/JS entrypoints'),
  integrity: z.string().optional().describe('"sha384-<base64>" digest of this file\'s exact bytes, for a <script>/<link integrity=...> attribute'),
}).describe('One file inside an artifact');

export const artifactSchema = z.object({
  tenantId: z.string().describe('The organization that owns this artifact'),
  partId: z.string().describe('The serve.part this is a build of'),
  ref: z.string().describe('The git ref (commit, branch, or tag) this was built from'),
  commit: z.string().optional().describe('The exact commit `ref` resolved to when this built; set once status is success. `ref` is often a branch, which moves -- this is what says which version the artifact actually is'),
  drivers: z.array(z.string()).optional().describe('serve.part (kind: driver) keys baked into this build; only set when the part being built is kind: kernel -- the same kernel part with a different driver set is a different artifact'),
  status: z.enum(['pending', 'running', 'success', 'failed']).default('pending').describe('Where this build attempt is'),
  hash: z.string().optional().describe('Content hash of the built output; set once status is success'),
  assets: z.array(artifactAssetSchema).optional().describe('Every file this artifact serves; set once status is success'),
  error: z.string().optional().describe('What went wrong; set once status is failed'),
  duration: z.number().optional().describe('How long this build took in seconds'),
  builtOn: z.string().optional().describe('nodeID that produced this build\'s files; set once status is success. ~/.mesh/artifacts is node-local disk, never replicated -- serve.part.start fetches from this node (serve.artifact.fetchAssetBytes) the first time a different node needs to load it'),
}).describe('One attempt to build a part at a git ref, and its output once it succeeds');
