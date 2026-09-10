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

import { callerMeta, executeGate, SCOPE_HEADER, type AuthorizeHook, type Caller } from './methods/gate.js';
import { resolveCaller } from './methods/caller.js';
import { coerceToSchema, formatZodError } from './methods/input.js';
import { toHttpError } from './methods/errors.js';
import type { ContractLookup } from './methods/routes.js';
import { callShapeOf, type DescribedCall, type ExposureDescriptor } from './schema/descriptor.js';
import type { TicketCache } from './methods/tickets.js';
import { DEFAULT_APPROVER } from '../approval/schema/approval.js';

/**
 * The one call this surface offers whether a site asked for it or not.
 *
 * Named here rather than imported as a contract so that `McpService` does not depend on
 * `ApprovalService` being in the process — `lookup` answers `undefined` when it is not, and the
 * surface simply offers nothing.
 */
const APPROVAL_CHECK = 'approval.check';

/**
 * **What this caller's roles put on the table, or `undefined` for "no roles are declared".**
 *
 * The narrow surface (`spec/mcp.md`). A site composing an `agent` part gets a role map on its
 * release — open-ended role names, each naming contract keys — and a caller sees the union of the
 * roles it holds. Ten worker accounts all hold `worker`; nothing enumerates accounts.
 *
 * Three answers, and the middle one is the one to get right:
 *
 * - **No map at all** → `undefined`, meaning *do not narrow*. Every site composed before agent parts
 *   existed is in this state, and narrowing them to nothing would take away a working MCP surface on
 *   an upgrade. Backwards compatibility, stated rather than accidental.
 * - **A map, and this caller holds none of its roles** → the empty set. **Not `undefined`.** A site
 *   that has decided what its agents may reach has decided that a caller outside those roles reaches
 *   nothing, and answering "do not narrow" here would invert the whole feature — the moment somebody
 *   declares a role, everyone *without* one would get everything.
 * - **A map and matching roles** → their union.
 *
 * `approval.check` is exempt and is added by `#surfaceCalls` regardless: the surface hands out an
 * approval id and owes the way to redeem it, and a role list that forgot to name it would strand an
 * agent holding one.
 */
function offeredTo(
    descriptor: ExposureDescriptor,
    caller: Caller | undefined,
): ReadonlySet<string> | undefined {
    const roles = descriptor.agentRoles;
    if (roles === undefined || Object.keys(roles).length === 0) return undefined;

    const held = new Set(caller?.roles ?? []);
    const keys = new Set<string>([APPROVAL_CHECK]);
    for (const [role, contracts] of Object.entries(roles)) {
        if (!held.has(role)) continue;
        for (const key of contracts) keys.add(key);
    }
    return keys;
}

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

            const caller = await this.#resolve(bearer(req));
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
                        descriptor, caller, scope, request.params ?? {}, host,
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

    /**
     * **A ticket or an API token, and the difference is kept.**
     *
     * A ticket belongs to somebody who typed a password. A token is issued *to a program* — which is
     * how an agent gets an identity of its own rather than borrowing a person's. That matters for
     * three separate reasons and only the third is obvious:
     *
     * 1. A `destructive` contract asks a person to confirm, and there is nobody to ask on a token.
     * 2. An audit saying *tim deleted the release* when tim's agent did is a lie that reads as fact.
     * 3. A token is revocable by itself, so an agent can be switched off without signing anybody out.
     *
     * Tried in that order, and a miss on both is **anonymous rather than refused** — the gate decides
     * whether anonymous is good enough, and a `public` contract is reachable without either.
     *
     * Two lookups on a miss is the cost. A prefixed token (`mst_…`) would let this route on sight
     * rather than by trying; worth doing when tokens are next touched, and not worth a migration on
     * its own.
     */
    async #resolve(credential: string | undefined): Promise<Caller | undefined> {
        return await resolveCaller(credential, {
            ...(this.options.tickets === undefined ? {} : { tickets: this.options.tickets }),
            call: (tool, params, options) => this.#call(tool, params, options),
        });
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
        const offered = offeredTo(descriptor, caller);

        for (const call of [...descriptor.calls, ...this.#surfaceCalls(descriptor)]) {
            if (call.stream) continue;   // a stream is not a tool result; see spec/mcp.md §7
            if (offered !== undefined && !offered.has(call.key)) continue;
            if (!await this.#permitted(call, caller, scope, descriptor.siteScope)) continue;

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
     * Calls this surface always offers, because this surface is what creates the need for them.
     *
     * **`approval.check` is not a site's contract to grant.** When the destructive rule parks a
     * call, the agent is handed an id and told to poll — and if the site had to remember to expose
     * the polling tool, the first site that forgot would leave every agent holding an id it could
     * never redeem. A surface that raises a question owes the way to hear the answer.
     *
     * Gated like anything else: `auth: 'user'`, and `approval.check` itself answers only to the
     * requester or an approver. Listed only when the contract is actually in the process — a node
     * running no `ApprovalService` offers nothing rather than offering a tool that 404s.
     */
    #surfaceCalls(descriptor: ExposureDescriptor): readonly DescribedCall[] {
        // The site exposes these too — `ApiService.surfaceContracts` puts them on every site — so
        // without this the tool list carried `approval_check` twice, once from each source.
        if (descriptor.calls.some((call) => call.key === APPROVAL_CHECK)) return [];

        const contract = this.lookup(APPROVAL_CHECK);
        if (contract === undefined) return [];

        return [{
            ...callShapeOf(contract, APPROVAL_CHECK),
            domain: contract.domain,
            action: contract.action,
            description: contract.description ?? '',
            gate: { kind: 'auth', level: 'user' },
        } as DescribedCall];
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
        siteScope: string | undefined,
    ): Promise<boolean> {
        const contract = this.lookup(call.key);
        if (contract === undefined) return false;

        const outcome = await executeGate({
            gate: call.gate,
            contract,
            caller,
            requestedScope: scope,
            siteScope,
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
        host: string,
    ): Promise<unknown> {
        const name = typeof params['name'] === 'string' ? params['name'] : '';
        const args = isRecord(params['arguments']) ? params['arguments'] : {};

        const offered = offeredTo(descriptor, caller);
        const call = [...descriptor.calls, ...this.#surfaceCalls(descriptor)]
            // The same narrowing `tools/list` applies. A tool that is not offered is not callable —
            // listing and calling reading one rule is what stops a stale list from being a way in.
            .filter((c) => offered === undefined || offered.has(c.key))
            .find((c) => toolName(c) === name);

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

        if (!await this.#permitted(call, caller, scope, descriptor.siteScope)) {
            const contract = this.lookup(call.key);
            const outcome = contract === undefined ? undefined : await executeGate({
                gate: call.gate,
                contract,
                caller,
                requestedScope: scope,
                siteScope: descriptor.siteScope,
                input: {},
                ...(this.options.authorize === undefined ? {} : { authorize: this.options.authorize }),
            });
            const why = outcome !== undefined && !outcome.ok ? outcome.message : 'Refused.';
            return toolError(`${name}: ${why}`);
        }

        /**
         * **A destructive contract refuses an agent, and only an agent.**
         *
         * This refused everybody, which was the honest thing while the service could not tell a
         * program from a person. It can now: a caller that arrived on an API token carries `agent`
         * and one that arrived on a ticket does not.
         *
         * So the rule is the one `spec/ui/rules.md` §7 always meant — *a destructive write asks a
         * person* — rather than a blunt approximation of it. A person driving MCP is a person; a
         * token is not, and no amount of it being a *trusted* token makes it one.
         */
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
            siteScope: descriptor.siteScope,
            input,
            ...(this.options.authorize === undefined ? {} : { authorize: this.options.authorize }),
        });
        if (!outcome.ok) return toolError(`${name}: ${outcome.message}`);

        /**
         * **A destructive call reached by an agent is parked, not refused.**
         *
         * This used to end here, with a message saying *"a person holding a session may call it"* —
         * true, and a dead end: nothing carried the request to that person, and the agent's only
         * move was to give up. `spec/mcp.md` §7 listed it as the thing to decide *before* serving a
         * destructive contract, and we are serving them.
         *
         * So the flag that already marks the calls needing a person now routes them to one. No
         * second concept: `destructive` is the whole condition, which is why the surface needs
         * nothing new declared on it.
         *
         * **Parked after the gate, deliberately.** A caller who could not make this call at all gets
         * a refusal, not a question — asking an operator to approve something the requester was
         * never entitled to would launder a refusal into a decision. The gate says *may they*;
         * this says *and does a person have to say so*.
         *
         * The pending answer is a **result, not an error**. An agent that reads waiting as failure
         * abandons every approval, and `isError` is how a model decides it has failed.
         */
        if (call.destructive && caller?.agent !== undefined && (this.options.destructive ?? 'refuse') === 'refuse') {
            return await this.#park(name, call, parsed.data, caller, outcome.scope, host);
        }

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
                    : { user: callerMeta(caller, outcome.scope) }),
                ...(outcome.scope === undefined ? {} : { tenant_id: outcome.scope }),
            },
        });

        return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            structuredContent: isRecord(result) ? result : { value: result },
        };
    }

    /**
     * Park a call and tell the agent how to hear the answer.
     *
     * The reply is shaped for a model to act on rather than for a log to record: it says what
     * happened, who has to decide, and the exact call to make next. A pending answer that does not
     * name `approval_check` leaves the agent to guess, and a guessing agent polls the wrong thing.
     *
     * **`isError` is not set.** Waiting is not failing, and `isError` is how a model decides it has
     * failed. Marking this an error would make every approval a dead end again, just a politer one.
     */
    async #park(
        name: string,
        call: DescribedCall,
        input: unknown,
        caller: Caller,
        scope: string | undefined,
        host: string,
    ): Promise<unknown> {
        /**
         * `role:operator` until a site says otherwise.
         *
         * The narrowest thing that is always true: an operator exists on every deployment. The
         * site's `authorize` hook naming its own approver is the next step and is where this
         * belongs — only a site knows what an organization means, which is the same reason the gate
         * takes a permission string rather than an enum.
         */
        const approver = DEFAULT_APPROVER;

        try {
            const parked = await this.#call('approval.request', {
                call: call.key,
                host,
                input: isRecord(input) ? input : { value: input },
                requestedBy: {
                    userId: caller.userId,
                    ...(caller.agent === undefined ? {} : { agent: caller.agent }),
                    roles: [...caller.roles],
                },
                approver,
            }, {
                meta: {
                    user: callerMeta(caller, scope),
                    ...(scope === undefined ? {} : { tenant_id: scope }),
                },
            }) as { approvalId: string; expiresAt: string };

            return {
                content: [{
                    type: 'text',
                    text:
                        `${name} needs a person to approve it. It has not run.\n\n`
                        + `approvalId: ${parked.approvalId}\n`
                        + `waiting on: ${approver}\n`
                        + `expires: ${parked.expiresAt}\n\n`
                        + `Call approval_check with this approvalId to see the decision. `
                        + `If it is approved the call runs with the input you sent, and the result comes back there — `
                        + `do not send ${name} again.`,
                }],
                structuredContent: {
                    status: 'pending',
                    approvalId: parked.approvalId,
                    approver,
                    expiresAt: parked.expiresAt,
                },
            };
        } catch (error) {
            /**
             * **A surface that cannot park has to refuse, and say which it did.**
             *
             * With no `ApprovalService` in the process, `approval.request` is not a tool and this
             * throws. Answering "needs approval" with no id would leave the agent polling nothing.
             * So it falls back to the old refusal — and names the reason, because "this node cannot
             * take approvals" is an operator's problem and not the agent's.
             */
            const why = error instanceof Error ? error.message : String(error);
            return toolError(
                `${name} changes state, and "${caller.agent}" is an API token rather than a person. `
                + `It could not be parked for approval on this node (${why}), so it was refused. `
                + `A person holding a session may call it.`,
            );
        }
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
