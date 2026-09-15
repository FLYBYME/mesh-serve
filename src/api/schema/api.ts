import { z } from 'zod';

export const apiSchema = z.object({
    tenantId: z.string().describe('The organization that owns this api'),
    apiHost: z.string().describe('The hostname that resolves to this api'),
    description: z.string().optional().describe('A human description of what this api is'),
}).describe('A hostname serving a REST+SSE api, independent of whether any frontend site uses it');
