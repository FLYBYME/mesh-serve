import { z } from 'zod';

export const exposeEntrySchema = z.union([
  z.object({
    contract: z.string().describe('The contract key (e.g. identity.user.find)'),
    auth: z.enum(['public', 'authenticated']).describe('No caller required, or any signed-in caller'),
    errors: z.array(z.string()).optional().describe('Declared errors for the contract, forms part of the public surface'),
  }),
  z.object({
    contract: z.string().describe('The contract key'),
    permission: z.string().describe('Permission pattern, checked against identity.grant'),
    errors: z.array(z.string()).optional().describe('Declared errors for the contract'),
  })
]).describe('Names one contract and exactly one gate; internal contracts are refused by describeExposure');
