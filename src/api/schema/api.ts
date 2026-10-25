import { z } from 'zod';

export const apiSchema = z.object({
    tenantId: z.string().describe('The organization that owns this api'),
    apiHost: z.string().describe('The hostname that resolves to this api'),
    description: z.string().optional().describe('A human description of what this api is'),
    exposeDeclared: z.boolean().optional().describe('Expose, with no serve.expose row, every public contract whose own permissions name a gate (e.g. ["operator"], ["member"]), gated by them. A row still exposes what declares no gate (public on purpose), and a row\'s role still adds to a contract\'s. For the platform\'s own api; absent on a customer\'s, which exposes only its rows'),
    exposeRoles: z.array(z.string()).optional().describe('With exposeDeclared: only what every role it requires is one of these -- e.g. ["member"] for a customers\' api, which then never shows an operator\'s call or event, not even its name. Absent: every declared gate'),
    protocol: z.enum(['rest', 'mcp']).optional().describe('How this api is spoken: "rest" (absent: rest) -- REST calls and /api/events -- or "mcp", an MCP server whose tools are its exposed contracts, gated, scoped and held exactly as the same calls over REST'),
}).describe('A hostname serving an api -- REST+SSE, or MCP -- independent of whether any frontend site uses it');
