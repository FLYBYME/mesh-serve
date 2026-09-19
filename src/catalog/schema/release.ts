import { z } from 'zod';

import { artifactAssetSchema } from './artifact.js';

// The full, already-built serve.artifact row (id/createdAt/updatedAt included -- matching exactly
// what defineCrud derives as artifactCrud's own OUTPUT shape), embedded whole rather than
// summarized. kind/imports are NOT copied here on purpose: they belong to the serve.part, not the
// artifact, and copying them onto the release risks drifting from the part if it's edited after
// this release is pinned. A reader (cdn.service.ts) resolves the part by artifact.partId when it
// needs them -- one source of truth, one extra lookup, instead of two places that can disagree.
//
// Declared directly against artifactCrud's output semantics (status required, no `.default()`)
// rather than extending artifact.ts's own base artifactSchema: that base is input-shaped (status
// optional, filled in by `.default()` on create) and embedding it verbatim produces a z.input/
// z.infer mismatch against releaseCrud's own derived output type, since this array is never itself
// used to create an artifact -- every entry here already is one, snapshotted as-is.
export const releaseArtifactSchema = z.object({
  id: z.string(),
  tenantId: z.string().describe('The organization that owns this artifact'),
  partId: z.string().describe('The serve.part this is a build of'),
  ref: z.string().describe('The git ref (commit, branch, or tag) this was built from'),
  drivers: z.array(z.string()).optional().describe('serve.part (kind: driver) keys baked into this build; only set when the part being built is kind: kernel'),
  status: z.enum(['pending', 'running', 'success', 'failed']).describe('Where this build attempt is'),
  hash: z.string().optional().describe('Content hash of the built output; set once status is success'),
  assets: z.array(artifactAssetSchema).optional().describe('Every file this artifact serves; set once status is success'),
  error: z.string().optional().describe('What went wrong; set once status is failed'),
  duration: z.number().optional().describe('How long this build took in seconds'),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
}).describe('One already-built serve.artifact, pinned into this release');

export const releaseSchema = z.object({
  tenantId: z.string().describe('The organization that owns this release'),
  compositionId: z.string().describe('The serve.composition this is a pinned snapshot of'),
  // Optional on create -- CatalogService's before-hook mints it from compositionId + artifacts when
  // absent (computeReleaseHash), so a caller pinning a release doesn't have to hand-roll the same
  // sha256 compose.ts already computes. Always present once stored.
  hash: z.string().describe('Content hash of this release: the composition plus its pinned artifacts').optional(),
  artifacts: z.array(releaseArtifactSchema).describe('Every artifact this release pins, one per part'),
}).describe('One pinned, built snapshot of a composition\'s parts');
