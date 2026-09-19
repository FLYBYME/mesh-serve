import { z } from 'zod';

export const compositionSchema = z.object({
  tenantId: z.string().describe('The organization that owns this composition'),
  key: z.string().describe('The namespace a site\'s application and open[].application point at'),
  kernelPartKey: z.string().describe('The serve.part id (kind: kernel) this composition boots from'),
  drivers: z.array(z.string()).describe('serve.part ids (kind: driver) baked into this composition\'s kernel build; absent from this list means the capability does not exist in the bundle at all, not merely disabled'),
  theme: z.string().optional().describe('The serve.part id (kind: theme) this composition uses, if any'),
  extensions: z.array(z.string()).describe('serve.part ids (kind: extension) that together make up this product'),
  applications: z.array(z.string()).describe('serve.part ids (kind: application) that together make up this product'),
  services: z.array(z.string()).describe('serve.part ids (kind: service) associated with this product -- started independently via serve.part.start, never composed into the site itself'),
  description: z.string().optional().describe('A human description of what this composition is'),
}).describe('Which parts combine to form one deployable product, released over time');
