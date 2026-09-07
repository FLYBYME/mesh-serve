import { defineContract, defineCrud, defaultPrint, z } from '@flybyme/mesh';
import {
    GroupSchema,
    NodeSchema,
    NodeStatusReportSchema,
} from '../schema/node.js';

export const nodeCrud = defineCrud('node', NodeSchema, {
    pluralPath: 'nodes',
    dependencies: [],
    unique: [{ fields: 'hostname', scope: 'global' }],
});

/**
 * Groups are a global collection, not a scoped one.
 *
 * The fleet belongs to the platform. Nobody outside it knows a machine exists, let alone which
 * group it is in — *"noone knows about a pod or droplet or k8s or any of it, it's all behind a
 * gate."* Scoping this by tenant would imply a customer could have their own, which is a different
 * product.
 */
export const groupCrud = defineCrud('group', GroupSchema, {
    pluralPath: 'groups',
    dependencies: [],
    unique: [{ fields: 'name', scope: 'global' }],
});

const reconcileOutcomeSchema = z.object({
    hostname: z.string(),
    services: z.array(z.string()),
    applied: z.boolean(),
    started: z.array(z.string()).optional(),
    stopped: z.array(z.string()).optional(),
    error: z.string().optional(),
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
        // Both optional: absent means unchanged, not empty. Putting a node in a group must not
        // silently clear the services it was given directly.
        services: z.array(z.string()).optional(),
        groups: z.array(z.string()).optional(),
    }),
    outputSchema: reconcileOutcomeSchema,
    rest: { method: 'POST', path: '/node/assign' },
    destructive: true,
    print: defaultPrint,
});

/**
 * The verb that makes a group mean something.
 *
 * Editing a group changes no running process by itself. Reconciling does — recompute each node's
 * desired set from its own services plus its groups, and apply the difference. Idempotent, so it is
 * safe on a timer, safe by hand, and safe twice.
 */
export const nodeReconcileContract = defineContract({
    domain: 'node',
    action: 'reconcile',
    description: 'Make what each node is running match what it should be running.',
    inputSchema: z.object({
        hostname: z.string().optional(),
        group: z.string().optional(),
    }),
    outputSchema: z.object({ reconciled: z.array(reconcileOutcomeSchema) }),
    rest: { method: 'POST', path: '/node/reconcile' },
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
