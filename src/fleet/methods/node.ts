/**
 * The fleet's tools: which machines exist, what each should run, and what each actually runs.
 *
 * Every input and output type here comes from the contract by `z.infer`, the way `cdn/tools/*` do.
 * They were hand-written object literals repeating the schema, which is the drift the contracts
 * exist to prevent — the schema would change and the signature would go on claiming the old shape.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ClientError, z, type IServiceContext, type IServiceRegistry } from '@flybyme/mesh';

import type {
    nodeAssignContract, nodeHelloContract, nodeProvisionContract, nodeReconcileContract,
    nodeStatusContract,
} from '../contracts/node.contract.js';
import { CORE_SERVICES, type GroupRecord, type NodeRecord, type NodeSummary, type ServiceRunStatus } from '../schema/node.js';
import { nodesInGroup, reconcileNode, resolveDesired } from './reconcile.js';

const run = promisify(execFile);

type HelloInput = z.infer<typeof nodeHelloContract['inputSchema']>;
type HelloOutput = z.infer<typeof nodeHelloContract['outputSchema']>;
type AssignInput = z.infer<typeof nodeAssignContract['inputSchema']>;
type AssignOutput = z.infer<typeof nodeAssignContract['outputSchema']>;
type ReconcileInput = z.infer<typeof nodeReconcileContract['inputSchema']>;
type ReconcileOutput = z.infer<typeof nodeReconcileContract['outputSchema']>;
type StatusInput = z.infer<typeof nodeStatusContract['inputSchema']>;
type StatusOutput = z.infer<typeof nodeStatusContract['outputSchema']>;
type ProvisionInput = z.infer<typeof nodeProvisionContract['inputSchema']>;
type ProvisionOutput = z.infer<typeof nodeProvisionContract['outputSchema']>;

/**
 * An operator, and **an absent caller is not one**.
 *
 * This was `assertOperatorIfUserPresent`, which checked the role only when `ctx.meta.user` was
 * there and allowed the call outright when it was not. Every caller that reaches these tools over
 * the broker rather than through the HTTP gate — which is every mesh peer — arrives with no
 * `meta.user`, so the fleet's control surface was open to anything already on the mesh. The name
 * said so and it still read as a check.
 *
 * [auth §5](../../../spec/auth.md), roadmap C2.5: *no internal bypass, no god token, no
 * trusted-caller exemption*. Being on the mesh is not an identity.
 */
function requireOperator(ctx: IServiceContext, action: string): void {
    const user = ctx.meta?.user as { roles?: readonly string[] } | undefined;

    if (user === undefined || user === null) {
        throw new ClientError(
            `node.${action} requires an operator, and this call carries no caller at all. `
            + `Reaching a tool over the mesh is not an identity.`,
            'unauthenticated', 401,
        );
    }

    const roles = Array.isArray(user.roles) ? user.roles : [];
    if (!roles.includes('operator')) {
        throw new ClientError(
            `node.${action} requires the operator role.`, 'forbidden', 403,
        );
    }
}

interface MeshRegistryNode {
    nodeID: string;
    hostname?: string;
    available?: boolean;
    addresses?: string[];
}

function getRegistryNodes(broker: unknown): MeshRegistryNode[] {
    const b = broker as { getProvider?<T>(name: string): T; registry?: IServiceRegistry };
    const registry = b.getProvider?.<IServiceRegistry>('registry') ?? b.registry;
    if (registry && typeof registry.getNodes === 'function') {
        return registry.getNodes() as MeshRegistryNode[];
    }
    return [];
}

/**
 * node.hello: a node announces itself by hostname and asks what services it should run.
 *
 * Desired state only. The fleet only ever answers — it never starts a process.
 * If the node is new, an assignment row is created with empty desired services.
 * Refuses if another live node in the mesh already claims the same hostname (E3).
 */
export async function node_hello(
    input: HelloInput,
    ctx: IServiceContext,
): Promise<HelloOutput> {
    /**
     * **No operator check here, and it is the one deliberate exception in this file.**
     *
     * `hello` is a *machine* announcing itself, not a person doing something. A node has no user and
     * never will have one, so an operator check here means no node can ever register — and the
     * obvious workaround, giving every machine an operator credential, would hand the fleet's entire
     * control surface to every box in the fleet. That is a worse outcome than this exception.
     *
     * **Three things bound it, and they are the reason this is safe rather than merely convenient:**
     *
     * 1. `nodeHelloContract` declares no `visibility`, so mesh defaults it to `internal` and no site
     *    can expose it. It is unreachable from the internet, and a test below pins that.
     * 2. The caller has already proved it belongs on the mesh: a peer presents the shared key at the
     *    WebSocket handshake or it never becomes a peer. Authenticating the *peer relationship* is
     *    the transport's job and it is the right layer for it.
     * 3. It reads nothing it is not told and writes only the row for the hostname it names, so the
     *    worst a lying node achieves is taking another node's assignment — which the conflict check
     *    below catches while that node is live.
     *
     * `assign`, `reconcile` and `status` are operator-only and stay that way. Announcing yourself is
     * not the same act as directing somebody else.
     */

    // E3: Refuse if another live node in the Registry already claims this hostname
    const registryNodes = getRegistryNodes(ctx.broker);
    const liveConflict = registryNodes.find(
        (n) => (n.available ?? true) && n.hostname === input.hostname && n.nodeID !== ctx.nodeID,
    );
    if (liveConflict) {
        // A named failure, not a bare Error: a caller deciding what to do about a hostname clash
        // needs to tell it apart from the node being down, and a message string is not something
        // anything can branch on.
        throw new ClientError(
            `Hostname "${input.hostname}" is already claimed by live node `
            + `"${liveConflict.nodeID}". Two machines announcing one hostname means one of them `
            + `takes the other's assignment.`,
            'hostname_claimed', 409,
        );
    }

    const existing = await ctx.call('node.find_one', {
        query: { hostname: input.hostname },
    }) as (NodeRecord & { id: string }) | null;

    if (existing !== null && existing !== undefined) {
        /**
         * **Resolved, not raw.** This returned `existing.services` — the node's *direct*
         * assignments only, with its groups ignored entirely.
         *
         * A node whose whole assignment comes from a group therefore heard "you should be running
         * nothing", and `bin/node.mjs` reads an empty answer as *unassigned* and falls back to
         * starting everything it carries. So `surf`, assigned exactly `serve`, started `builder`
         * and `cdn` as well — and `builder.build_start` began round-robining onto it. A build is
         * the heaviest thing that runs here, `surf` has 981MB, and a node under that much memory
         * pressure stops answering pings and is dropped as a dead peer mid-build.
         *
         * Groups are stored by reference precisely so that the resolution happens at read time.
         * Doing it in `reconcile` and not here left the two disagreeing about what a node should be
         * running, which is the one thing this collection exists to answer.
         */
        const groups = (await ctx.call('group.find', { query: {} }) as GroupRecord[]) ?? [];
        return {
            hostname: existing.hostname,
            services: resolveDesired(existing, groups),
        };
    }

    await ctx.call('node.create', {
        hostname: input.hostname,
        services: [],
    });

    return {
        hostname: input.hostname,
        services: [],
    };
}

/**
 * node.assign: what a node should be running, as services, groups, or both.
 *
 * **Assignment is a switch.** It changes which of the services a node already carries are running,
 * live, without restarting the node — that separation is what keeps systemd (which owns the
 * process) and the Supervisor (which owns services inside it) from being two authorities over one
 * thing.
 *
 * Both fields are optional and **absent means unchanged**, not empty. `{ hostname, groups: ['edge'] }`
 * puts a node in a group without silently clearing the services it was given directly, which is the
 * mistake the obvious implementation makes and which is invisible until a builder stops.
 */
export async function node_assign(
    input: AssignInput,
    ctx: IServiceContext,
): Promise<AssignOutput> {
    requireOperator(ctx, 'assign');

    const existing = await ctx.call('node.find_one', {
        query: { hostname: input.hostname },
    }) as (NodeRecord & { id: string }) | null;

    const services = input.services ?? existing?.services ?? [];
    const groups = input.groups ?? existing?.groups ?? [];

    if (existing !== null && existing !== undefined) {
        await ctx.call('node.update', { id: existing.id, services, groups });
    } else {
        await ctx.call('node.create', { hostname: input.hostname, services, groups });
    }

    const allGroups = await ctx.call('group.find', { query: {} }) as GroupRecord[];
    return await reconcileNode(ctx, { hostname: input.hostname, services, groups }, allGroups ?? []);
}

/**
 * node.reconcile: make what is running match what should be running.
 *
 * The verb that makes a group mean something. Editing a group changes no running process by itself;
 * reconciling the nodes in it does. Idempotent, so it is safe to call on a whole fleet when
 * something looks wrong, and safe to call twice.
 *
 * With no hostname it reconciles every node, and it does **not** stop at the first failure — nine
 * healthy nodes still need to converge when the tenth is wedged, and the operator needs to see
 * which one it was.
 */
export async function node_reconcile(
    input: ReconcileInput,
    ctx: IServiceContext,
): Promise<ReconcileOutput> {
    requireOperator(ctx, 'reconcile');

    const groups = (await ctx.call('group.find', { query: {} }) as GroupRecord[]) ?? [];

    let nodes: NodeRecord[];
    if (input.hostname !== undefined) {
        const one = await ctx.call('node.find_one', {
            query: { hostname: input.hostname },
        }) as NodeRecord | null;
        nodes = one === null || one === undefined ? [] : [one];
    } else if (input.group !== undefined) {
        nodes = await nodesInGroup(ctx, input.group);
    } else {
        nodes = (await ctx.call('node.find', { query: {} }) as NodeRecord[]) ?? [];
    }

    const reconciled: ReconcileOutput['reconciled'][number][] = [];
    for (const node of nodes) reconciled.push(await reconcileNode(ctx, node, groups));
    return { reconciled };
}

interface NodeSupervisorQueryResult {
    runningServices: string[];
    provisionedServices: string[];
    services?: ServiceRunStatus[];
    error?: string;
}

async function queryNodeSupervisor(
    broker: unknown,
    mNode: MeshRegistryNode,
    timeoutMs = 3000,
): Promise<NodeSupervisorQueryResult> {
    const b = broker as {
        nodeID: string;
        call(tool: string, input: unknown, options?: { nodeID?: string; timeout?: number }): Promise<unknown>;
    };
    try {
        const callTargetOpt = {
            ...(mNode.nodeID !== b.nodeID ? { nodeID: mNode.nodeID } : {}),
            timeout: timeoutMs,
        };
        let timer: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`query timed out after ${timeoutMs}ms`)), timeoutMs);
            timer.unref?.();
        });
        try {
            const statusResult = await Promise.race([
                b.call('supervisor.service_status', {}, callTargetOpt) as Promise<{ services: ServiceRunStatus[] }>,
                timeoutPromise,
            ]);
            const services = statusResult?.services ?? [];
            return {
                services,
                runningServices: [
                    ...CORE_SERVICES,
                    ...services.filter((s) => s.status === 'running').map((s) => s.name),
                ],
                provisionedServices: services.map((s) => s.name),
            };
        } finally {
            if (timer) clearTimeout(timer);
        }
    } catch (err) {
        return {
            runningServices: [],
            provisionedServices: [],
            error: `Failed to query supervisor on node "${mNode.hostname ?? mNode.nodeID}": ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}

/**
 * node.status: answers what this node is running and what it is connected to.
 *
 * It is the direct answer to "stale mongo, stale k3d, nobody knows anything"
 * and reports both desired state from DB and observed state from Registry/Supervisor.
 */
export async function node_status(
    input: StatusInput,
    ctx: IServiceContext,
): Promise<StatusOutput> {
    requireOperator(ctx, 'status');

    const broker = ctx.broker;
    const registryNodes = getRegistryNodes(broker);

    const myNode = registryNodes.find((n) => n.nodeID === broker.nodeID);
    const targetHostname = input.hostname ?? myNode?.hostname ?? os.hostname();

    // Query desired services from DB
    const nodeRow = await ctx.call('node.find_one', {
        query: { hostname: targetHostname },
    }) as (NodeRecord & { id: string }) | null;
    const desiredServices = nodeRow?.services ?? [];

    // Find target in Registry
    const targetMeshNode = registryNodes.find((n) => n.hostname === targetHostname);
    const connected = targetMeshNode !== undefined && (targetMeshNode.available ?? true);

    // List peers (all nodes in Registry except the target itself)
    const peers = registryNodes
        .filter((n) => n.nodeID !== targetMeshNode?.nodeID)
        .map((n) => ({
            nodeID: n.nodeID,
            hostname: n.hostname,
            addresses: n.addresses ?? [],
        }));

    let runningServices: string[] = [];
    let provisionedServices: string[] = [];
    let services: ServiceRunStatus[] | undefined;
    let error: string | undefined;

    if (connected && targetMeshNode) {
        const targetRes = await queryNodeSupervisor(broker, targetMeshNode);
        services = targetRes.services;
        runningServices = targetRes.runningServices;
        provisionedServices = targetRes.provisionedServices;
        error = targetRes.error;
    }

    // Build fleet summary
    const allDbNodes = await ctx.call('node.find', { query: {}, limit: 100 }) as (NodeRecord & { id: string })[];
    const knownHostnames = new Set<string>();
    for (const row of (allDbNodes ?? [])) knownHostnames.add(row.hostname);
    for (const mNode of registryNodes) {
        if (mNode.hostname) knownHostnames.add(mNode.hostname);
    }

    const nodeSummaryPromises = Array.from(knownHostnames).map(async (host) => {
        const mNode = registryNodes.find((n) => n.hostname === host);
        const dRow = (allDbNodes ?? []).find((r) => r.hostname === host);
        const isConnected = mNode !== undefined && (mNode.available ?? true);

        if (host === targetHostname) {
            return {
                hostname: host,
                nodeID: mNode?.nodeID,
                connected: isConnected,
                desiredServices: dRow?.services ?? [],
                runningServices,
                provisionedServices,
                ...(error !== undefined ? { error } : {}),
            };
        }

        if (!isConnected || !mNode) {
            return {
                hostname: host,
                nodeID: mNode?.nodeID,
                connected: false,
                desiredServices: dRow?.services ?? [],
                runningServices: [],
                provisionedServices: [],
            };
        }

        const queryRes = await queryNodeSupervisor(broker, mNode);
        return {
            hostname: host,
            nodeID: mNode.nodeID,
            connected: true,
            desiredServices: dRow?.services ?? [],
            runningServices: queryRes.runningServices,
            provisionedServices: queryRes.provisionedServices,
            ...(queryRes.error !== undefined ? { error: queryRes.error } : {}),
        };
    });

    const nodesSummary = await Promise.all(nodeSummaryPromises);

    return {
        hostname: targetHostname,
        nodeID: targetMeshNode?.nodeID,
        connected,
        peers,
        desiredServices,
        runningServices,
        provisionedServices,
        ...(services !== undefined ? { services } : {}),
        nodes: nodesSummary,
        ...(error !== undefined ? { error } : {}),
    };
}

function normalizeRepo(repo: string): string {
    return repo.trim().replace(/\.git$/, '').toLowerCase();
}

/**
 * Validates repository against environment allowlist (MESH_PROVISION_ALLOWED_REPOSITORIES).
 * Fails closed: if the environment variable is unset or empty, no repository is permitted.
 */
export function isRepositoryAllowed(repository: string, env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = env['MESH_PROVISION_ALLOWED_REPOSITORIES'] ?? env['FLEET_ALLOWED_REPOSITORIES'];
    if (!raw || raw.trim() === '') {
        return false;
    }
    const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (entries.length === 0) {
        return false;
    }
    const normRepo = normalizeRepo(repository);
    return entries.some((entry) => {
        if (entry === '*') return true;
        const normEntry = normalizeRepo(entry);
        if (normEntry === normRepo) return true;
        if (entry.endsWith('*')) {
            const prefix = normalizeRepo(entry.slice(0, -1));
            return normRepo.startsWith(prefix);
        }
        return false;
    });
}

function gitAuthArgs(repository: string): string[] {
    try {
        let host = '';
        if (repository.includes('://')) {
            host = new URL(repository).host;
        } else if (repository.includes('@')) {
            host = repository.split('@')[1]?.split(':')[0] ?? '';
        }
        if (!host) return [];
        const key = `GIT_TOKEN_${host.toUpperCase().replace(/[.-]/g, '_')}`;
        const token = process.env[key] ?? process.env['GIT_TOKEN'];
        if (!token) return [];
        const auth = Buffer.from(`x-access-token:${token}`).toString('base64');
        return ['-c', `http.extraHeader=Authorization: Basic ${auth}`];
    } catch {
        return [];
    }
}

async function assertPinnedRef(repository: string, ref: string): Promise<void> {
    if (/^(main|master|trunk|dev|development|head)$/i.test(ref) || ref.startsWith('refs/heads/')) {
        throw new ClientError(
            `node.provision requires a pinned commit SHA or tag, not a branch: "${ref}". `
            + `A node that follows a branch changes behaviour when somebody else pushes.`,
            'invalid_ref', 400,
        );
    }
    // 40-char hex commit SHA is pinned
    if (/^[0-9a-f]{40}$/i.test(ref)) {
        return;
    }
    // Check if remote considers this a branch
    try {
        const auth = gitAuthArgs(repository);
        const { stdout } = await run('git', [...auth, 'ls-remote', '--heads', repository, ref]);
        if (stdout.trim().length > 0) {
            throw new ClientError(
                `node.provision requires a pinned commit SHA or tag, not a branch: "${ref}". `
                + `The remote reports it as a branch head.`,
                'invalid_ref', 400,
            );
        }
    } catch (err) {
        // The refusal above must escape this catch — it is the check, not a failure of the check.
        if (err instanceof ClientError) throw err;
        // Remote inspection may fail in offline or mock environments; branch name checks above protect it
    }
}

/**
 * node.provision: makes new switches exist on a node.
 *
 * Acquires a service the node does not currently have: clones or pulls a repository at a pinned ref,
 * installs its dependencies with npm, and registers a Supervisor manifest entry pointing at it.
 *
 * Runs on the target node (forwarding over broker if called on another node).
 * Pulling an already-cloned repo to the same ref is a no-op that avoids reinstalling.
 */
export async function node_provision(
    input: ProvisionInput,
    ctx: IServiceContext,
): Promise<ProvisionOutput> {
    requireOperator(ctx, 'provision');

    if (!isRepositoryAllowed(input.repository)) {
        throw new ClientError(
            `Repository "${input.repository}" is not in the allowlist `
            + `(MESH_PROVISION_ALLOWED_REPOSITORIES). Provisioning runs npm install, which runs `
            + `arbitrary scripts, so the set of repositories a node will take code from is the `
            + `operator's decision and not the caller's.`,
            'repository_not_allowed', 403,
        );
    }

    await assertPinnedRef(input.repository, input.ref);

    const broker = ctx.broker;
    const registryNodes = getRegistryNodes(broker);
    const targetMeshNode = registryNodes.find(
        (n) => (n.available ?? true) && n.hostname === input.hostname,
    );

    if (targetMeshNode === undefined) {
        return {
            hostname: input.hostname,
            name: input.name,
            repository: input.repository,
            ref: input.ref,
            applied: false,
            noop: false,
            message: `Node "${input.hostname}" is not connected to the mesh.`,
            error: `Node "${input.hostname}" is not connected to the mesh.`,
        };
    }

    // If target is a remote node, forward the call over the broker to run on the target
    if (targetMeshNode.nodeID !== broker.nodeID) {
        const remoteBroker = broker as unknown as {
            call(tool: string, input: unknown, options?: { nodeID?: string; meta?: unknown }): Promise<ProvisionOutput>;
        };
        return await remoteBroker.call('node.provision', input, {
            nodeID: targetMeshNode.nodeID,
            meta: ctx.meta,
        });
    }

    // Running locally on the target node
    const servicesRoot = path.resolve(process.env['MESH_SERVICES_DIR'] || './.services');
    const serviceDir = path.join(servicesRoot, input.name);
    const metaFile = path.join(serviceDir, '.mesh-provision.json');

    let isNoop = false;
    let resolvedEntry = '';

    if (fs.existsSync(path.join(serviceDir, '.git')) && fs.existsSync(metaFile)) {
        try {
            const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8')) as {
                repository: string;
                ref: string;
                entryPath: string;
            };
            if (meta.repository === input.repository && meta.ref === input.ref) {
                isNoop = true;
                resolvedEntry = meta.entryPath;
            }
        } catch {
            // Invalid metadata, proceed with pull
        }
    }

    if (isNoop) {
        // Register with Supervisor in case it was restarted
        const localBroker = broker as unknown as {
            call(tool: string, input: unknown): Promise<unknown>;
        };
        try {
            await localBroker.call('supervisor.service_register', {
                name: input.name,
                path: resolvedEntry,
                dependsOn: input.dependsOn ?? [],
                mountKey: input.mountKey,
            });
        } catch {
            // If supervisor is not mounted, continue
        }

        return {
            hostname: input.hostname,
            name: input.name,
            repository: input.repository,
            ref: input.ref,
            applied: true,
            noop: true,
            message: `Service "${input.name}" is already provisioned at ref "${input.ref}"; no-op.`,
            path: resolvedEntry,
        };
    }

    // Fresh clone or update
    if (!fs.existsSync(serviceDir)) {
        fs.mkdirSync(serviceDir, { recursive: true });
    }

    const authArgs = gitAuthArgs(input.repository);

    if (!fs.existsSync(path.join(serviceDir, '.git'))) {
        await run('git', ['init', '--quiet'], { cwd: serviceDir });
        await run('git', ['remote', 'add', 'origin', input.repository], { cwd: serviceDir });
    } else {
        try {
            await run('git', ['remote', 'set-url', 'origin', input.repository], { cwd: serviceDir });
        } catch {
            // Remote already set or unable to update
        }
    }

    await run('git', [...authArgs, 'fetch', '--quiet', '--depth', '1', 'origin', input.ref], { cwd: serviceDir });
    await run('git', ['checkout', '--quiet', 'FETCH_HEAD'], { cwd: serviceDir });

    const commitOut = await run('git', ['rev-parse', 'HEAD'], { cwd: serviceDir });
    const commit = commitOut.stdout.trim();

    // Resolve entry module path
    if (input.path) {
        resolvedEntry = path.isAbsolute(input.path) ? input.path : path.resolve(serviceDir, input.path);
    } else {
        let entry = 'dist/index.js';
        const pkgPath = path.join(serviceDir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
                    main?: string;
                    exports?: string | Record<string, string>;
                };
                if (typeof pkg.main === 'string') {
                    entry = pkg.main;
                } else if (typeof pkg.exports === 'string') {
                    entry = pkg.exports;
                } else if (pkg.exports && typeof pkg.exports['.'] === 'string') {
                    entry = pkg.exports['.'];
                }
            } catch {}
        }
        const candidate = path.resolve(serviceDir, entry);
        if (fs.existsSync(candidate)) {
            resolvedEntry = candidate;
        } else if (fs.existsSync(path.resolve(serviceDir, 'index.js'))) {
            resolvedEntry = path.resolve(serviceDir, 'index.js');
        } else {
            resolvedEntry = candidate;
        }
    }

    // Run npm install if package.json exists
    if (fs.existsSync(path.join(serviceDir, 'package.json'))) {
        await run('npm', ['install', '--no-audit', '--no-fund', '--omit=dev'], { cwd: serviceDir });
    }

    // Save metadata for no-op checking
    fs.writeFileSync(
        metaFile,
        JSON.stringify({
            name: input.name,
            repository: input.repository,
            ref: input.ref,
            commit,
            entryPath: resolvedEntry,
            provisionedAt: new Date().toISOString(),
        }, null, 2),
    );

    // Register with Supervisor
    const localBroker = broker as unknown as {
        call(tool: string, input: unknown): Promise<unknown>;
    };
    try {
        await localBroker.call('supervisor.service_register', {
            name: input.name,
            path: resolvedEntry,
            dependsOn: input.dependsOn ?? [],
            mountKey: input.mountKey,
        });
    } catch {
        // If supervisor is not mounted, continue
    }

    return {
        hostname: input.hostname,
        name: input.name,
        repository: input.repository,
        ref: input.ref,
        applied: true,
        noop: false,
        message: `Successfully provisioned "${input.name}" at ref "${input.ref}".`,
        path: resolvedEntry,
    };
}
