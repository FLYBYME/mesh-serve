import type { Command } from 'commander';

import { originOf } from './client.js';
import type { Session } from './session.js';

export interface DescribedCall {
    readonly key: string;
    readonly domain: string;
    readonly action: string;
    readonly description: string;
    readonly method: string;
    readonly path: string;
    readonly gate: string;
    readonly input?: unknown;
    readonly output?: unknown;
    readonly destructive?: boolean;
    readonly stream?: boolean;
}

interface ExposureDescriptor {
    readonly base: string;
    readonly calls: readonly DescribedCall[];
}

interface JsonSchemaObject {
    readonly properties?: Record<string, { readonly description?: string }>;
    readonly required?: readonly string[];
}

function isJsonSchemaObject(schema: unknown): schema is JsonSchemaObject {
    return typeof schema === 'object' && schema !== null;
}

async function fetchDescriptor(session: Session): Promise<ExposureDescriptor | undefined> {
    try {
        const res = await fetch(`${originOf(session.apiHost)}/api/_describe`);
        if (!res.ok) return undefined;
        return await res.json() as ExposureDescriptor;
    } catch {
        return undefined;
    }
}

function fillPath(base: string, path: string, args: Record<string, unknown>): { url: string; rest: Record<string, unknown> } {
    const rest = { ...args };
    const filled = path.replace(/:([a-zA-Z0-9_]+)/g, (_, name: string) => {
        const value = rest[name];
        if (value === undefined) throw new Error(`Missing required path parameter "${name}".`);
        delete rest[name];
        return encodeURIComponent(String(value));
    });
    return { url: `${base}${filled}`, rest };
}

async function execute(session: Session, base: string, call: DescribedCall, args: Record<string, unknown>): Promise<unknown> {
    const { url: path, rest } = fillPath(base, call.path, args);
    let url = `${originOf(session.apiHost)}${path}`;

    const headers: Record<string, string> = {};
    if (session.credential !== undefined) headers['Authorization'] = `Bearer ${session.credential}`;

    let body: string | undefined;
    if (call.method === 'GET' || call.method === 'DELETE') {
        const qs = new URLSearchParams();
        for (const [key, value] of Object.entries(rest)) {
            if (value === undefined) continue;
            qs.set(key, typeof value === 'string' ? value : JSON.stringify(value));
        }
        const qsString = qs.toString();
        if (qsString.length > 0) url += `?${qsString}`;
    } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(rest);
    }

    const res = await fetch(url, { method: call.method, headers, body });
    const text = await res.text();
    let json: unknown;
    try {
        json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
        json = text;
    }

    if (!res.ok) {
        const message = (json !== undefined && typeof json === 'object' && json !== null && 'error' in json)
            ? String((json as { error: unknown }).error)
            : res.statusText;
        throw new Error(`${call.key} failed: ${res.status} ${message}`);
    }

    return json;
}

/**
 * Everything this host exposes right now, as a `domain action [--flag value...]` Commander tree --
 * on top of, not instead of, the fixed baseline commands. `generate` produces a real typed client for
 * an app to build against; this is the other half of "SDK is standalone" -- a way to poke at whatever
 * a host exposes from the terminal without writing a client first, the same job `curl` would do except
 * it already knows the shape and the auth header.
 *
 * Fetched fresh every run rather than cached: the old CLI cached `_describe` in the session file and
 * needed `refresh`/`switch` to invalidate it, which is exactly the kind of staleness this session's
 * generated-client redesign was built to avoid elsewhere. One fetch per invocation is the honest
 * trade for a local dev tool. Silent no-op when the host isn't reachable -- the fixed commands
 * (`start`, `switch`, `login`) still need to work with nothing running yet.
 */
export async function attachDynamicCommands(program: Command, session: Session): Promise<void> {
    const descriptor = await fetchDescriptor(session);
    if (descriptor === undefined) return;

    const byDomain = new Map<string, DescribedCall[]>();
    for (const call of descriptor.calls) {
        const list = byDomain.get(call.domain) ?? [];
        list.push(call);
        byDomain.set(call.domain, list);
    }

    for (const [domain, calls] of byDomain) {
        const domainCmd = program.command(domain).description(`${domain} calls, exposed at ${session.apiHost}`);

        for (const call of calls) {
            const actionCmd = domainCmd.command(call.action).description(call.description);

            const schema = call.input;
            if (isJsonSchemaObject(schema) && schema.properties !== undefined) {
                for (const [field, fieldSchema] of Object.entries(schema.properties)) {
                    const required = schema.required?.includes(field) ?? false;
                    actionCmd.option(
                        required ? `--${field} <value>` : `--${field} [value]`,
                        fieldSchema.description ?? '',
                    );
                }
            }

            actionCmd.action(async (opts: Record<string, unknown>) => {
                const result = await execute(session, descriptor.base, call, opts);
                console.log(JSON.stringify(result, null, 2));
            });
        }
    }
}
