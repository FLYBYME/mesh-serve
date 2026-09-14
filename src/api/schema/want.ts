import { z } from 'zod';

export const wantSchema = z.object({
  tenantId: z.string().describe('The organization that owns this site'),
  siteId: z.string().describe('The serve.site whose parts declare this want'),
  contract: z.string().describe('The domain.action key this site\'s parts call'),
}).describe('One contract a site\'s parts declare they need to call, regardless of whether it is exposed');
