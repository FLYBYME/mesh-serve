import { defineContract, defineCrud, z } from '@flybyme/mesh';

import { apiSchema } from '../schema/api.js';

export const apiCrud = defineCrud('serve.api', apiSchema, {
    pluralPath: 'apis',
    scopedBy: 'tenantId',
    unique: [{ fields: 'apiHost', scope: 'global' }],
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public', create: 'public',
    },
    dependencies: [],
    filePath: 'src/api/contracts/api.contract.ts',
    permissions: [],
});

export type Api = z.infer<typeof apiCrud.outputSchema>;

export const resolveApiByIdInputSchema = z.object({
    id: z.string().min(1).describe('The api id'),
}).describe('One api, by id, for a caller who does not yet know its tenant');

export const resolveApiByIdOutputSchema = apiCrud.get.outputSchema;

export const apiResolveByIdContract = defineContract({
    domain: 'serve.api',
    action: 'resolveById',
    description: 'One api, by id, for a caller who does not yet know its tenant.',
    inputSchema: resolveApiByIdInputSchema,
    outputSchema: resolveApiByIdOutputSchema,
    rest: { method: 'GET', path: '/apis/id/:id' },
    visibility: 'public',
    filePath: 'src/api/contracts/api.contract.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => `${o.apiHost} (${o.tenantId})`,
});

export type ResolveApiByIdInput = z.infer<typeof apiResolveByIdContract.inputSchema>;
export type ResolveApiByIdOutput = z.infer<typeof apiResolveByIdContract.outputSchema>;

export const resolveApiByHostInputSchema = z.object({
    apiHost: z.string().min(1).describe('The hostname an api connection arrived on'),
}).describe('One api, by hostname, for an anonymous connection');

export const resolveApiByHostOutputSchema = apiCrud.get.outputSchema;

export const apiResolveByHostContract = defineContract({
    domain: 'serve.api',
    action: 'resolveByHost',
    description: 'One api, by hostname, for an anonymous connection.',
    inputSchema: resolveApiByHostInputSchema,
    outputSchema: resolveApiByHostOutputSchema,
    rest: { method: 'GET', path: '/apis/host/:apiHost' },
    visibility: 'public',
    filePath: 'src/api/contracts/api.contract.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => `${o.apiHost} (${o.tenantId})`,
});

export type ResolveApiByHostInput = z.infer<typeof apiResolveByHostContract.inputSchema>;
export type ResolveApiByHostOutput = z.infer<typeof apiResolveByHostContract.outputSchema>;

export const describedCallSchema = z.object({
    key: z.string(),
    domain: z.string(),
    action: z.string(),
    description: z.string(),
    method: z.string(),
    path: z.string(),
    gate: z.string(),
    input: z.unknown().describe('JSON Schema for this call\'s input'),
    output: z.unknown().describe('JSON Schema for this call\'s output'),
    destructive: z.boolean().optional(),
    stream: z.boolean().optional(),
});

export const exposureDescriptorSchema = z.object({
    host: z.string(),
    base: z.string(),
    exposure: z.string(),
    shapeHash: z.string(),
    calls: z.array(describedCallSchema),
});

export const describeInputSchema = z.object({
    host: z.string().min(1).describe('The api hostname to describe the exposed surface of'),
}).describe('The same descriptor _describe returns over HTTP, callable in-process');

export const describeOutputSchema = exposureDescriptorSchema;

/**
 * The in-process twin of GET /api/_describe -- handleDescribe (api.service.ts) builds the exact
 * same ExposureDescriptor for an HTTP caller; this is that same buildDescriptor call, reachable by
 * ctx.call for a peer that needs a contract's real JSON Schema + destructive flag by key and isn't
 * itself an HTTP client. mesh-infer's tool loop is the first caller: an LLM needs a real schema to
 * call a tool correctly, and the turn loop needs `destructive` to decide hold vs. direct execution,
 * for a tool that may live on an entirely different node than the one asking.
 */
export const apiDescribeContract = defineContract({
    domain: 'serve.api',
    action: 'describe',
    description: 'The exposed, gated, schema-carrying surface of one api, by hostname.',
    inputSchema: describeInputSchema,
    outputSchema: describeOutputSchema,
    rest: { method: 'GET', path: '/apis/host/:host/describe' },
    visibility: 'public',
    filePath: 'src/api/contracts/api.contract.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => `${o.calls.length} calls on ${o.host}`,
});

export type DescribeInput = z.infer<typeof apiDescribeContract.inputSchema>;
export type DescribeOutput = z.infer<typeof apiDescribeContract.outputSchema>;
