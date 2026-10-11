import { z } from 'zod';

export const apiSchema = z.object({
    tenantId: z.string().describe('The organization that owns this api'),
    apiHost: z.string().describe('The hostname that resolves to this api'),
    description: z.string().optional().describe('A human description of what this api is'),
    exposeDeclared: z.boolean().optional().describe('Expose, with no serve.expose row, every public contract whose own permissions name a gate (e.g. ["operator"], ["member"]), gated by them. A row still exposes what declares no gate (public on purpose), and a row\'s role still adds to a contract\'s. For the platform\'s own api; absent on a customer\'s, which exposes only its rows'),
}).describe('A hostname serving a REST+SSE api, independent of whether any frontend site uses it');
