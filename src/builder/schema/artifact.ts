import { z } from 'zod';
import { declarationSchema } from './declaration';

export const artifactSchema = z.object({
  digest: z.string().describe('The name. Content-addressed digest of the artifact bytes'),
  files: z.array(z.object({
    path: z.string(),
    digest: z.string(),
    size: z.number(),
    contentType: z.string(),
  })).describe('Files contained in the artifact'),
  totalSize: z.number().describe('Total size in bytes'),
  builtAt: z.date().describe('When it was built'),
  buildId: z.string().describe('Which attempt produced it'),
  declaration: declarationSchema.describe('What it is and what it needs'),
  state: z.enum(['available', 'gone']).describe('available | gone (gone means rebuildable, not broken)'),
}).describe('The bytes one build produced, named by their digest');
