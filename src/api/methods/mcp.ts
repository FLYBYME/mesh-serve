/**
 * An api whose protocol is `mcp` (design/mcp.md): its exposure rows as MCP tools, and the
 * JSON-RPC 2.0 messages of MCP's Streamable HTTP transport. Pure -- the gateway does the calling,
 * through the same path as a REST call (gate, tenant, holds, activity).
 */

/** The newest protocol version this server speaks: what a client asking for another one gets. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** Every protocol version this server speaks. */
export const MCP_PROTOCOL_VERSIONS: readonly string[] = [MCP_PROTOCOL_VERSION, '2025-03-26'];

/** JSON-RPC's own error codes. */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;

export interface RpcRequest {
    readonly id?: string | number;
    readonly method: string;
    readonly params: Record<string, unknown>;
}

export interface McpTool {
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
    readonly annotations: { readonly readOnlyHint: boolean; readonly destructiveHint: boolean };
}

/** What a tool is made from: an exposure row's contract, as the gateway routes it. */
export interface ToolSource {
    readonly key: string;
    readonly description: string;
    readonly method: string;
    readonly destructive: boolean;
    readonly input: Record<string, unknown>;
}

/**
 * A contract key as a tool name: `.` is not allowed in a tool name by every client (Claude's own
 * api takes `^[a-zA-Z0-9_-]{1,64}$`), so `dnsZone.find` is `dnsZone_find`. Never read back by
 * reversing it -- `infer.agents.run_find` has its own `_` -- but through the name table toolsOf makes.
 */
export function toolName(key: string): string {
    return key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/** A JSON Schema an MCP client accepts as a tool's input: always an object. */
function objectSchema(input: Record<string, unknown>): Record<string, unknown> {
    return input['type'] === 'object' ? input : { type: 'object', properties: {} };
}

/**
 * One tool per source, by name. A second source with the same name is left out (and said, by the
 * caller), never allowed to shadow the first.
 */
export function toolsOf(sources: readonly ToolSource[]): { tools: McpTool[]; byName: Map<string, ToolSource>; clashes: string[] } {
    const byName = new Map<string, ToolSource>();
    const tools: McpTool[] = [];
    const clashes: string[] = [];
    for (const source of [...sources].sort((a, b) => a.key.localeCompare(b.key))) {
        const name = toolName(source.key);
        if (byName.has(name)) {
            clashes.push(source.key);
            continue;
        }

        byName.set(name, source);
        tools.push({
            name,
            title: source.key,
            description: source.description !== '' ? source.description : source.key,
            inputSchema: objectSchema(source.input),
            annotations: { readOnlyHint: source.method === 'GET', destructiveHint: source.destructive },
        });
    }

    return { tools, byName, clashes };
}

/** One JSON-RPC message from a parsed body, or why it is not one. */
export function rpcRequestOf(body: unknown): RpcRequest | { readonly error: string } {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return { error: 'Expected one JSON-RPC message (an object).' };
    }

    const method: unknown = Reflect.get(body, 'method');
    if (Reflect.get(body, 'jsonrpc') !== '2.0' || typeof method !== 'string') {
        return { error: 'Not a JSON-RPC 2.0 request.' };
    }

    const id: unknown = Reflect.get(body, 'id');
    const params: unknown = Reflect.get(body, 'params');

    return {
        ...(typeof id === 'string' || typeof id === 'number' ? { id } : {}),
        method,
        params: typeof params === 'object' && params !== null && !Array.isArray(params) ? Object.fromEntries(Object.entries(params)) : {},
    };
}

export function rpcResult(id: string | number | undefined, result: unknown): Record<string, unknown> {
    return { jsonrpc: '2.0', id: id ?? null, result };
}

export function rpcError(id: string | number | undefined, code: number, message: string): Record<string, unknown> {
    return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** `initialize`'s answer: the version asked for when this server speaks it, else its newest. */
export function initializeResult(params: Record<string, unknown>, host: string, version: string): Record<string, unknown> {
    const asked = params['protocolVersion'];

    return {
        protocolVersion: typeof asked === 'string' && MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: host, version },
        instructions: `Tools are the calls exposed on ${host}. A call that changes or removes something may be held for a person's decision: its answer then names the hold, and it runs only once approved.`,
    };
}

/** A tool's answer: its result as text, and as structured content when it is an object. */
export function callResult(result: unknown): Record<string, unknown> {
    return {
        content: [{ type: 'text', text: JSON.stringify(result ?? null) }],
        ...(typeof result === 'object' && result !== null && !Array.isArray(result) ? { structuredContent: result } : {}),
        isError: false,
    };
}

/** A held call's answer: not an error -- it was asked for, and now waits for a person. */
export function heldResult(key: string, hold: unknown): Record<string, unknown> {
    const id = typeof hold === 'object' && hold !== null ? Reflect.get(hold, 'id') : undefined;

    return {
        content: [{
            type: 'text',
            text: `${key} is held for a decision${typeof id === 'string' ? ` (hold ${id})` : ''}: it changes or removes something, so it runs only once a person approves it. Nothing has changed yet.`,
        }],
        isError: false,
    };
}

/** A refused or failed call, said to the model as the tool's answer (MCP: tool errors are results). */
export function errorResult(message: string): Record<string, unknown> {
    return { content: [{ type: 'text', text: message }], isError: true };
}
