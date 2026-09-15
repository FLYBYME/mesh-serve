import { z } from 'zod';

export const releasePartSchema = z.object({
  partKey: z.string().describe('The serve.part key this entry pins'),
  kind: z.enum(['kernel', 'application', 'extension', 'driver', 'theme']).describe('Copied from serve.part.kind at release time, so a reader never needs a second lookup to classify this entry'),
  artifactHash: z.string().describe('The serve.artifact hash built for that part'),
  imports: z.string().optional().describe('Copied from serve.part.imports at release time -- present means the site\'s import map points this specifier at this part\'s artifact; absent means nothing else may import it'),
}).describe('One part, pinned to the artifact built for it');

export const releaseSchema = z.object({
  tenantId: z.string().describe('The organization that owns this release'),
  compositionId: z.string().describe('The serve.composition this is a pinned snapshot of'),
  hash: z.string().describe('Content hash of this release: the composition plus its pinned parts'),
  parts: z.array(releasePartSchema).describe('Every part this release pins, and the artifact built for it'),
}).describe('One pinned, built snapshot of a composition\'s parts');
