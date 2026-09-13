import { defineContract, z } from '@flybyme/mesh';

export const describeInputSchema = z.object({
    host: z.string().min(1).describe('The hostname to describe'),
});

export const describeOutputSchema = z.object({
    host: z.string(),
    base: z.string(),
    exposure: z.string().describe('The hash a generated client carries and the api reports'),
    shapeHash: z.string().describe('The site-independent shape hash over contracts and schemas'),
    calls: z.array(z.object({
        key: z.string(),
        method: z.string(),
        path: z.string(),
        description: z.string(),
        gate: z.string().describe("`public`, `user`, `admin`, or `permission:<key>`"),
        destructive: z.boolean(),
        input: z.unknown().describe('JSON Schema'),
        output: z.unknown().describe('JSON Schema'),
    })),
});

export const describeContract = defineContract({
    domain: 'serve.api',
    action: 'describe',
    description: 'What a hostname exposes: routes, shapes, and the gate in front of each.',
    inputSchema: describeInputSchema,
    outputSchema: describeOutputSchema,
    rest: { method: 'GET', path: '/api/describe' },
    visibility: 'public',
    print: (o) => `${o.host}: ${String(o.calls.length)} call(s), exposure ${o.exposure}`,
});

export type DescribeInput = z.infer<typeof describeContract.inputSchema>;
export type DescribeOutput = z.infer<typeof describeContract.outputSchema>;

export const statusInputSchema = z.object({});

export const statusOutputSchema = z.object({
    status: z.enum(['ok', 'degraded', 'critical']),
    version: z.string().describe('The version of the API.'),
    uptime: z.number().describe('The uptime of the API in seconds.'),
    details: z.record(z.string(), z.string()).optional().describe('Detailed status information.'),
});

export const statusContract = defineContract({
    domain: 'serve.api',
    action: 'status',
    description: 'Get the status of the API.',
    inputSchema: statusInputSchema,
    outputSchema: statusOutputSchema,
    rest: { method: 'GET', path: '/api/status' },
    visibility: 'public',
    print: (o) => `API Status: ${o.status}`,
});

export type StatusInput = z.infer<typeof statusContract.inputSchema>;
export type StatusOutput = z.infer<typeof statusContract.outputSchema>;