import { z } from 'zod';

export const compositionSchema = z.object({
  tenantId: z.string().describe('The organization that owns this composition'),
  key: z.string().describe('The namespace a site\'s application and open[].application point at'),
  kernelPartKey: z.string().describe('The serve.part (kind: kernel) this composition boots from'),
  drivers: z.array(z.string()).describe('serve.part (kind: driver) keys baked into this composition\'s kernel build; absent from this list means the capability does not exist in the bundle at all, not merely disabled'),
  theme: z.string().optional().describe('The serve.part (kind: theme) key this composition uses, if any'),
  parts: z.array(z.string()).describe('The serve.part (kind: application/extension) keys that together make up this product'),
  description: z.string().optional().describe('A human description of what this composition is'),
}).describe('Which parts combine to form one deployable product, released over time');
