import { defineContract, defineCrud, defaultPrint, z } from '@flybyme/mesh';
import {
    NodeSchema,
    NodeStatusReportSchema,
} from '../schema/node.js';

export const nodeCrud = defineCrud('node', NodeSchema, {
    pluralPath: 'nodes',
    dependencies: [],
    unique: [{ fields: 'hostname', scope: 'global' }],
});

export const nodeHelloContract = defineContract({
    domain: 'node',
    action: 'hello',
    description: 'A node announces itself by hostname and receives its desired service assignment.',
    inputSchema: z.object({
        hostname: z.string().min(1),
    }),
    outputSchema: z.object({
        hostname: z.string(),
        services: z.array(z.string()),
    }),
    rest: { method: 'POST', path: '/node/hello' },
    print: defaultPrint,
});

export const nodeAssignContract = defineContract({
    domain: 'node',
    action: 'assign',
    description: 'Assigns desired services to a node by hostname, switching services live on running nodes.',
    inputSchema: z.object({
        hostname: z.string().min(1),
        services: z.array(z.string()),
    }),
    outputSchema: z.object({
        hostname: z.string(),
        services: z.array(z.string()),
        applied: z.boolean(),
        started: z.array(z.string()).optional(),
        stopped: z.array(z.string()).optional(),
        error: z.string().optional(),
    }),
    rest: { method: 'POST', path: '/node/assign' },
    destructive: true,
    print: defaultPrint,
});

export const nodeStatusContract = defineContract({
    domain: 'node',
    action: 'status',
    description: 'Answers what a node (or this node) is running and what it is connected to.',
    inputSchema: z.object({
        hostname: z.string().optional(),
    }),
    outputSchema: NodeStatusReportSchema,
    rest: { method: 'GET', path: '/node/status' },
    destructive: false,
    print: defaultPrint,
});
