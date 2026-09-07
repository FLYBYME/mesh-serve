import { defineContract, defineCrud, defaultPrint, z } from '@flybyme/mesh';
import {
    GroupSchema,
    NodeProvisionInputSchema,
    NodeProvisionOutcomeSchema,
    NodeSchema,
    NodeStatusReportSchema,
} from '../schema/node.js';

export const nodeCrud = defineCrud('node', NodeSchema, {
    pluralPath: 'nodes',
    dependencies: [],
    unique: [{ fields: 'hostname', scope: 'global' }],

    /**
     * Reads exposable, writes not — and `public` here means *may be exposed*, never
     * *unauthenticated*.
     *
     * The gate is the site's, and every site that exposes these gates them at `operator`. So a
     * customer's admin cannot reach them at all, and the console can list the fleet. Without this
     * the collection is internal, `describeExposure` refuses to publish it, and a fleet console can
     * be written but never talk to anything.
     *
     * Writes stay internal because a node's desired state is `node.assign`'s business: assigning
     * reconciles the running services, and a bare `node.update` would change the row and leave the
     * machine running what it was running — desired and observed silently diverging, which is the
     * one thing this collection exists to prevent.
     */
    visibility: { find: 'public', findOne: 'public', get: 'public', count: 'public' },
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

    /**
     * Reads **and** the two writes an operator does from a console: creating a group and editing
     * what is in one. Gated at `operator` by every site that exposes them.
     *
     * `delete` stays internal. Deleting a group silently drops its services from every node that
     * references it, and the nodes only find out at the next reconcile — that is a fine thing to do
     * deliberately from a CLI and a bad thing to have one button away from a list.
     */
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public',
        create: 'public', update: 'public',
    },
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
    visibility: 'public',
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
    visibility: 'public',
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
    visibility: 'public',
    rest: { method: 'GET', path: '/node/status' },
    destructive: false,
    print: defaultPrint,
});

/**
 * node.provision: makes new switches exist on a node.
 *
 * Acquires a service the node does not currently have: clones or pulls a repository at a pinned ref,
 * installs its dependencies with npm, and registers a Supervisor manifest entry pointing at it.
 *
 * Two hard requirements:
 * 1. A ref, not a branch. Mutable refs (main, master, etc.) are strictly refused.
 * 2. Protected by the operator gate and an allowlist of repositories from the environment.
 */
export const nodeProvisionContract = defineContract({
    domain: 'node',
    action: 'provision',
    description: 'Provisions a service onto a node by acquiring its repository at a pinned ref, installing dependencies, and registering it in the Supervisor manifest.',
    inputSchema: NodeProvisionInputSchema,
    outputSchema: NodeProvisionOutcomeSchema,
    rest: { method: 'POST', path: '/node/provision' },
    destructive: true,
    print: defaultPrint,
});
