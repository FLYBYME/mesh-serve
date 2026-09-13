import { z } from 'zod';

export const declarationSchema = z.object({
  part: z.object({
    kind: z.enum(['kernel', 'application', 'extension']).describe('Kind of the part'),
    id: z.string().describe('The part ID'),
    version: z.string().describe('The version range or specific version'),
    entry: z.string().describe('Entrypoint for the part'),
  }).describe('What it is'),
  kernel: z.string().optional().describe('Which kernel it targets'),
  requires: z.array(z.string()).describe('Capability names'),
  requiredParts: z.array(z.object({
    id: z.string().describe('The part ID'),
    version: z.string().describe('Version requirement for the part'),
  })).describe('Other parts, by id and range'),
  builtAgainst: z.array(z.object({
    package: z.string(),
    version: z.string(),
    commit: z.string(),
  })).describe('Package, version, commit — what was actually resolved. Makes a build explicable'),
}).describe('What the artifact is and what it needs');
