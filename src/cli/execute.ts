import { baseUrl, type DescribedCall } from './describe.js';
import type { Session } from './session.js';

function fillPath(path: string, args: Record<string, unknown>): { path: string; rest: Record<string, unknown> } {
    const rest = { ...args };
    const filled = path.replace(/:([a-zA-Z0-9_]+)/g, (_, name: string) => {
        const value = rest[name];
        if (value === undefined) {
            throw new Error(`Missing required path parameter "${name}".`);
        }
        delete rest[name];
        return encodeURIComponent(String(value));
    });
    return { path: filled, rest };
}

export interface ExecuteResult {
    readonly status: number;
    readonly shapeHash: string | undefined;
    readonly body: unknown;
}

/**
 * Performs one call over plain HTTP against an already-running api server -- this is an external
 * REST client, never a mesh peer. No ServiceBroker, no network transport, no cluster membership.
 */
export async function executeCall(session: Session, call: DescribedCall, args: Record<string, unknown>): Promise<ExecuteResult> {
    const { path, rest } = fillPath(call.path, args);
    let url = `${baseUrl(session.apiHost)}${path}`;

    const headers: Record<string, string> = {};
    if (session.credential !== undefined) {
        headers['Authorization'] = `Bearer ${session.credential}`;
    }

    let body: string | undefined;
    if (call.method === 'GET' || call.method === 'DELETE') {
        const qs = new URLSearchParams();
        for (const [key, value] of Object.entries(rest)) {
            if (value === undefined) continue;
            qs.set(key, typeof value === 'string' ? value : JSON.stringify(value));
        }
        const qsString = qs.toString();
        if (qsString.length > 0) {
            url += `?${qsString}`;
        }
    } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(rest);
    }

    const res = await fetch(url, { method: call.method, headers, body });
    const shapeHash = res.headers.get('x-exposure-shape') ?? undefined;

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

    return { status: res.status, shapeHash, body: json };
}
