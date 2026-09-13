import { z } from 'zod';

export const organizationSchema = z.object({
  slug: z.string().describe('The slug is what a URL or header names'),
  name: z.string().describe('Display name of the organization'),
  ownerId: z.string().describe('Who owns this organization'),
}).describe('Who owns things: sites, repositories, parts');
