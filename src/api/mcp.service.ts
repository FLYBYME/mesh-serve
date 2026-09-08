/**
 * **A site's exposure, served to an agent as MCP tools.**
 *
 * The same projection `ApiService` performs, with `tool` where `route` was:
 *
 * ```
 * Host → site → descriptor → gate → broker.call(key, input, { meta }) → tool result
 * ```
 *
 * Every step is a lookup except the gate — and the gate is the *same* gate, not a similar one.
 *
 * ## Why this is a service and not a script
 *
 * `ApiService` does not decide what is callable. It reads `describeExposure` — `visibility`, the
 * site's grants, the gate level — and serves what is there. That is the property that lets adding a
 * contract add a route without anybody editing a route table, and the property that keeps a
 * generated client honest.
 *
 * Until now that projection existed for HTTP and for the client generator, and **not for agents** —
 * so every MCP server was hand-written. flowboard wrote one, and every defect in it follows from the
 * surface being written rather than derived: the tool list was a hardcoded array crossed with four
 * hardcoded actions, `visibility` was consequently decorative (marking a contract `internal` changed
 * nothing), and the gating tools sat outside the descriptor entirely — no gate, no scope, invisible
 * to `_describe`, reachable by anyone who reached the endpoint.
 *
 * > An MCP surface is a projection of a site's exposure, exactly as HTTP is. It is not a place where
 * > a person chooses what an agent may call.
 *
 * ## The tool list is per-caller
 *
 * `tools/list` runs the gate, exactly as `tools/call` does. Two agents holding different tickets
 * against one site see different tools.
 *
 * That is what makes a narrow surface a **contract rather than a convention**: a worker does not see
 * a tool it cannot call, and does not have to be trusted not to try. It is also the answer to
 * wanting several audiences over one board — an orchestrating session and a dispatched worker are
 * different callers, not different URLs. An endpoint per audience is a hand-maintained list per
 * audience, and they drift the first time somebody adds a tool.
 *
 * ## No SDK
 *
 * MCP over HTTP, for a server with no session-scoped state, is JSON-RPC 2.0 over POST: `initialize`,
 * `tools/list`, `tools/call`. `ApiService` serves HTTP with `node:http` rather than taking express,
 * and this follows it — every call here is one broker round trip, so there is nothing a session
 * would hold and nothing a transport library would carry.
 *
 * See `spec/mcp.md`.
 */

import { MeshError, ServiceModule, type IServiceBroker } from '@flybyme/mesh';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { executeGate, SCOPE_HEADER, type AuthorizeHook, type Caller } from './methods/gate.js';
import { coerceToSchema, formatZodError } from './methods/input.js';
import { toHttpError } from './methods/errors.js';
import type { ContractLookup } from './methods/routes.js';
import type { DescribedCall, ExposureDescriptor } from './schema/descriptor.js';
import type { TicketCache } from './methods/tickets.js';

// ---------------------------------------------------------------------------- the protocol

/** JSON-RPC 2.0, the subset MCP needs. `id` absent means a notification, which wants no reply. */
interface JsonRpcRequest {
    readonly jsonrpc: '2.0';
    readonly id?: string | number | null;
    readonly method: string;
    readonly params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = '2025-06-18';

/**
 * MCP's own error codes are JSON-RPC's. A **refusal is not a protocol error** — see `callTool`.
 */
const enum RpcCode {
    ParseError = -32700,
    InvalidRequest = -32600,
    MethodNotFound = -32601,
    InvalidParams = -32602,
    InternalError = -32603,
}

// ---------------------------------------------------------------------------- options

export interface McpServiceOptions {
    readonly port?: number;
    /** The path the endpoint answers on. One path: audiences are gate levels, not URLs. */
    readonly path?: string;
    readonly serverName?: string;
    /**
     * Resolves a ticket to a caller. The **same** cache the api uses when they share a process, so a
     * ticket validated for an HTTP call is not validated again for a tool call.
     */
    readonly tickets?: TicketCache;
    /** The site's permission hook. A permission the site cannot evaluate is refused, never assumed. */
    readonly authorize?: AuthorizeHook;
    /**
     * How a `destructive` contract is treated when the caller is an agent.
     *
     * **Open in `spec/mcp.md` §7 and deliberately not decided here.** A destructive contract asks a
     * person in a browser (`spec/ui/rules.md` §7) and an agent has no person to ask. `'refuse'` is
     * the default because it fails closed: a platform that silently let an agent through a check
     * built for a human would be making that decision on the site's behalf, and quietly.
     *
     * `'allow'` is for a site that has decided its agents are trusted operators and says so.
     */
    readonly destructive?: 'refuse' | 'allow';
}

// ---------------------------------------------------------------------------- the service

export class McpService extends ServiceModule {
    readonly domain = 'mcp';

    #server: Server | undefined;
    #broker: IServiceBroker | undefined;

    constructor(
        private readonly descriptorFor: (host: string) => Promise<ExposureDescriptor | undefined>,
        private readonly lookup: ContractLookup,
        private readonly options: McpServiceOptions = {},
    ) {
        super();
    }

    public port: number | undefined;

    async onStart(broker: IServiceBroker): Promise<void> {
        return this.started(broker);
    }

    async onStop(): Promise<void> {
        return this.stopped();
    }

    async started(broker: IServiceBroker): Promise<void> {
        this.#broker = broker;
        const port = this.options.port ?? 4000;
        this.#server = createServer((req, res) => { void this.#handle(req, res); });
        await new Promise<void>((resolve) => {
            this.#server?.listen(port, () => {
                const addr = this.#server?.address();
                if (typeof addr === 'object' && addr !== null) {
                    this.port = addr.port;
                } else {
                    this.port = port;
                }
                resolve();
            });
        });
    }

    async stopped(): Promise<void> {
        const server = this.#server;
        this.#server = undefined;
        this.port = undefined;
        if (server !== undefined) await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    }

    // ------------------------------------------------------------------ http

    async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const path = this.options.path ?? '/mcp';
        if ((req.url ?? '').split('?')[0] !== path) return sendJson(res, 404, { error: 'NO_ROUTE' });

        if (req.method !== 'POST') {
            // GET is how the streamable transport opens a server-initiated stream. Nothing here
            // initiates anything, so saying so is more honest than holding a connection open.
            return sendJson(res, 405, rpcError(null, RpcCode.InvalidRequest, 'Method not allowed. POST JSON-RPC.'));
        }

        let request: JsonRpcRequest;
        try {
            request = JSON.parse(await readBody(req)) as JsonRpcRequest;
        } catch {
            return sendJson(res, 400, rpcError(null, RpcCode.ParseError, 'Invalid JSON.'));
        }

        const id = request.id ?? null;
        const host = (req.headers['host'] ?? '').split(':')[0] ?? '';

        try {
            const descriptor = await this.descriptorFor(host);
            if (descriptor === undefined) {
                return sendJson(res, 404, rpcError(id, RpcCode.InvalidRequest, `No site serves ${host}.`));
            }

            // The ticket, from the one place it is read. An invalid one makes the caller
            // **anonymous**, not refused — the gate decides whether anonymous is good enough, and a
            // public contract is reachable without one.
            const caller = await this.options.tickets?.resolve(bearer(req));
            const scope = header(req, SCOPE_HEADER);

            switch (request.method) {
                case 'initialize':
                    return sendJson(res, 200, rpcResult(id, {
                        protocolVersion: PROTOCOL_VERSION,
                        capabilities: { tools: { listChanged: false } },
                        serverInfo: {
                            name: this.options.serverName ?? descriptor.application,
                            version: descriptor.exposure.slice(0, 12),
                        },
                    }));

                case 'notifications/initialized':
                    return sendJson(res, 202, '');

                case 'tools/list':
                    return sendJson(res, 200, rpcResult(id, {
                        tools: await this.#toolsFor(descriptor, caller, scope),
                    }));

                case 'tools/call':
                    return sendJson(res, 200, rpcResult(id, await this.#callTool(
                        descriptor, caller, scope, request.params ?? {},
                    )));

                default:
                    return sendJson(res, 200, rpcError(id, RpcCode.MethodNotFound, `Unknown method: ${request.method}`));
            }
        } catch (error) {
            const { status, body } = toHttpError(error);
            if (status >= 500) this.#broker?.logger.error(`[mcp] ${host}`, error);
            return sendJson(res, 200, rpcError(id, RpcCode.InternalError, body.message ?? 'Internal error.'));
        }
    }

    // ------------------------------------------------------------------ tools/list

    /**
     * **The gate runs here, not only on call.**
     *
     * A tool this caller may not reach is not listed, so a worker's tool list *is* its permissions.
     * The alternative — list everything and refuse on call — teaches an agent to try, and makes a
     * transcript full of refusals that read as bugs.
     */
    async #toolsFor(
        descriptor: ExposureDescriptor,
        caller: Caller | undefined,
        scope: string | undefined,
    ): Promise<readonly unknown[]> {
        const tools: unknown[] = [];

        for (const call of descriptor.calls) {
            if (call.stream) continue;   // a stream is not a tool result; see spec/mcp.md §7
            if (!await this.#permitted(call, caller, scope)) continue;

            tools.push({
                name: toolName(call),
                description: describeFor(call, this.options.destructive ?? 'refuse'),
                inputSchema: call.input ?? { type: 'object', properties: {} },
                annotations: {
                    readOnlyHint: !call.destructive,
                    destructiveHint: call.destructive,
                },
            });
        }

        return tools;
    }

    /**
     * Whether this caller may reach this call *right now*.
     *
     * Runs the real gate with an empty input. That is sound for listing because the coarse checks —
     * is there a session, is this an operator, is the permission satisfiable — do not read the
     * input; a per-record refusal is a matter for the call itself and cannot be answered in advance
     * anyway.
     */
    async #permitted(
        call: DescribedCall,
        caller: Caller | undefined,
        scope: string | undefined,
    ): Promise<boolean> {
        const contract = this.lookup(call.key);
        if (contract === undefined) return false;

        const outcome = await executeGate({
            gate: call.gate,
            contract,
            caller,
            requestedScope: scope,
            input: {},
            ...(this.options.authorize === undefined ? {} : { authorize: this.options.authorize }),
        });

        return outcome.ok;
    }

    // ------------------------------------------------------------------ tools/call

    /**
     * **A refusal is a tool result, not a protocol error.**
     *
     * MCP distinguishes the two, and the distinction matters here: a JSON-RPC error says *this
     * conversation went wrong*, and a result with `isError` says *the thing you asked for was
     * refused, and here is why*. An agent can act on the second — sign in, ask for a scope, give up
     * and say so — and can only retry the first.
     *
     * So the four refusal reasons the gate already produces travel to the caller intact.
     */
    async #callTool(
        descriptor: ExposureDescriptor,
        caller: Caller | undefined,
        scope: string | undefined,
        params: Record<string, unknown>,
    ): Promise<unknown> {
        const name = typeof params['name'] === 'string' ? params['name'] : '';
        const args = isRecord(params['arguments']) ? params['arguments'] : {};

        const call = descriptor.calls.find((c) => toolName(c) === name);

        /**
         * Absent and refused are answered differently, on purpose.
         *
         * A tool nobody exposes is a mistake in the caller. A tool this caller may not reach is a
         * fact about the caller. An agent that cannot tell them apart retries the second forever,
         * and a person reading the transcript cannot tell either.
         */
        if (call === undefined) {
            return toolError(`No tool named ${name}. It may not exist, or this site may not expose it.`);
        }

        if (!await this.#permitted(call, caller, scope)) {
            const contract = this.lookup(call.key);
            const outcome = contract === undefined ? undefined : await executeGate({
                gate: call.gate,
                contract,
                caller,
                requestedScope: scope,
                input: {},
                ...(this.options.authorize === undefined ? {} : { authorize: this.options.authorize }),
            });
            const why = outcome !== undefined && !outcome.ok ? outcome.message : 'Refused.';
            return toolError(`${name}: ${why}`);
        }

        if (call.destructive && (this.options.destructive ?? 'refuse') === 'refuse') {
            return toolError(
                `${name} changes state and this site does not let an agent do that unattended. ` +
                `A destructive contract asks a person to confirm, and there is no person on this call.`,
            );
        }

        const contract = this.lookup(call.key);
        if (contract === undefined) return toolError(`${name}: no contract behind an exposed call.`);

        const input = coerceToSchema(contract.inputSchema, args);
        const parsed = contract.inputSchema.safeParse(input);
        if (!parsed.success) return toolError(`${name}: ${formatZodError(parsed.error)}`);

        const outcome = await executeGate({
            gate: call.gate,
            contract,
            caller,
            requestedScope: scope,
            input,
            ...(this.options.authorize === undefined ? {} : { authorize: this.options.authorize }),
        });
        if (!outcome.ok) return toolError(`${name}: ${outcome.message}`);

        /**
         * Who is asking, carried across the broker — identical to the api's.
         *
         * The scope comes from the **gate**, never from the request: a caller names an organization
         * and the gate resolves it against their memberships, so what reaches the handler is a scope
         * they may act in rather than one they asked for.
         *
         * `unauthenticated: true` when nobody resolved. Absence is not a safe signal — an internal
         * broker call also has no user and is expected to see everything, and reading "no user" as
         * "internal" is what handed every organization on the platform to an anonymous HTTP caller.
         */
        const result = await this.#call(call.key, parsed.data, {
            meta: {
                ...(caller === undefined
                    ? { unauthenticated: true }
                    : { user: { id: caller.userId, tenant_id: outcome.scope ?? '', roles: [...caller.roles] } }),
                ...(outcome.scope === undefined ? {} : { tenant_id: outcome.scope }),
            },
        });

        return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: isRecord(result) ? result : { value: result },
        };
    }

    /**
     * One narrow structural retype, not `any`.
     *
     * `broker.call<K extends keyof IServiceToolRegistry>` cannot accept a name chosen at request
     * time, because a run-time `string` never narrows to one of its literal keys. `ApiService` has
     * the same shape and solves it the same way.
     */
    async #call(tool: string, params: unknown, options: { meta: Record<string, unknown> }): Promise<unknown> {
        const broker = this.#broker;
        if (broker === undefined) throw new MeshError({ code: 'NOT_STARTED', status: 503, message: 'mcp is not started.' });
        return await (broker as unknown as {
            call(tool: string, params: unknown, options: unknown): Promise<unknown>;
        }).call(tool, params, options);
    }
}

// ---------------------------------------------------------------------------- helpers

/**
 * `domain_action`, because MCP tool names are a flat namespace and `.` is not accepted everywhere.
 *
 * Derived rather than declared, so a contract cannot be exposed under a name that disagrees with the
 * one the api and the generated client use.
 */
const toolName = (call: DescribedCall): string => `${call.domain}_${call.action}`;

const describeFor = (call: DescribedCall, destructive: 'refuse' | 'allow'): string => {
    const base = call.description === '' ? `${call.domain}.${call.action}` : call.description;
    if (!call.destructive) return base;
    return destructive === 'refuse'
        ? `${base} (changes state; refused for unattended callers on this site)`
        : `${base} (changes state)`;
};

const toolError = (message: string): unknown => ({
    content: [{ type: 'text', text: message }],
    isError: true,
});

const rpcResult = (id: string | number | null, result: unknown): unknown => ({ jsonrpc: '2.0', id, result });

const rpcError = (id: string | number | null, code: number, message: string): unknown =>
    ({ jsonrpc: '2.0', id, error: { code, message } });

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

const header = (req: IncomingMessage, name: string): string | undefined => {
    const value = req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
};

const bearer = (req: IncomingMessage): string | undefined => {
    const value = header(req, 'authorization');
    return value?.startsWith('Bearer ') === true ? value.slice(7) : undefined;
};

const readBody = async (req: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    return body === '' ? '{}' : body;
};

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    if (body === '') {
        res.writeHead(status).end();
        return;
    }
    const text = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(text)),
    }).end(text);
};
