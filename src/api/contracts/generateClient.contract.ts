import { defineContract, z } from '@flybyme/mesh';

export const generateClientInputSchema = z.object({
    apiId: z.string().min(1).describe('The serve.api whose exposure to render a client for'),
    contracts: z.array(z.string()).optional().describe('Narrow to these contract keys (e.g. one part\'s resolved "wants"); absent renders everything the api exposes'),
}).describe('Render the browser-safe, type-safe client for one api\'s current exposure');

export const generateClientOutputSchema = z.object({
    source: z.string().describe('The generated .ts file, ready to write to disk'),
}).describe('One generated client file');

export const generateClientContract = defineContract({
    domain: 'serve.api',
    action: 'generateClient',
    description: 'Render the browser-safe, type-safe client for one api\'s current exposure.',
    inputSchema: generateClientInputSchema,
    outputSchema: generateClientOutputSchema,
    // POST, not GET: `contracts` is an array, and GET query params never get JSON-parsed back out
    // server-side (api.service.ts's parseInput takes url.searchParams values as plain strings) --
    // a body carries it as real JSON instead of forcing an array through a query string.
    rest: { method: 'POST', path: '/generate-client' },
    visibility: 'public',
    print: (o) => `${o.source.length} bytes`,
});

export type GenerateClientInput = z.infer<typeof generateClientContract.inputSchema>;
export type GenerateClientOutput = z.infer<typeof generateClientContract.outputSchema>;
