import type { DescribedCall, ExposureDescriptor } from '../../api/methods/descriptor.js';

/**
 * The CLI's HTTP client for one api gate.
 *
 * Deliberately plain `fetch` against the REST routes each contract already declares, rather than
 * the generated client: `serve.api.generateClient` renders *TypeScript source* for an application
 * to compile, which is no use to a process that has to call a surface it discovered a moment ago.
 * `GET /api/_describe` carries the same information as data (method, path, JSON Schema per call),
 * which is what a dynamic CLI actually needs.
 *
 * This is also the boundary the whole design rests on: after `bootstrap`, the CLI is an ordinary
 * api client with no mesh access, subject to the same `serve.expose` rows and permission floors as
 * a browser. If something cannot be done through here, it cannot be done -- which is the point,
 * because it makes an incomplete api impossible to not notice.
 */

/** What the gateway returns on failure: `{ error: message }` with the real status (gateway.ts:95). */
interface ErrorBody { readonly error?: unknown }

export class ApiError extends Error {
    public constructor(
        message: string,
        public readonly status: number,
        public readonly url: string,
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

/** Trailing slashes are how `http://api.localhost:3223/` becomes `.../api//_describe`. */
function origin(apiUrl: string): string {
    return apiUrl.replace(/\/+$/, '');
}

async function readError(res: Response, url: string): Promise<ApiError> {
    let message = `${String(res.status)} ${res.statusText}`;
    try {
        const body = await res.json() as ErrorBody;
        if (typeof body.error === 'string' && body.error.length > 0) message = body.error;
    } catch {
        // A non-JSON body (a proxy's own error page, a truncated response) leaves the status line,
        // which is more useful than the parse failure would be.
    }
    return new ApiError(message, res.status, url);
}

/**
 * The api's exposed surface. `public` and ungated (`permissions: []`), so this works before login
 * -- `switch` can show what an api offers without asking who you are.
 */
export async function describeApi(apiUrl: string): Promise<ExposureDescriptor> {
    const url = `${origin(apiUrl)}/api/_describe`;
    let res: Response;
    try {
        res = await fetch(url);
    } catch (err) {
        // fetch's own failures are opaque ("fetch failed") with the real cause nested, and the
        // cause is nearly always the one thing worth saying: nothing is listening there.
        const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
        throw new ApiError(`Cannot reach ${url}${cause !== undefined ? ` (${cause})` : ''}`, 0, url);
    }
    if (!res.ok) throw await readError(res, url);
    return await res.json() as ExposureDescriptor;
}

/**
 * Fills `:name` segments from `input` and returns the path plus whatever was not consumed.
 *
 * Path params are removed from the remaining input on purpose: the gateway merges them *over* the
 * body/query (`parseInput`: `{ ...body, ...params }`), so sending an id in both places is harmless
 * but sending a *different* one in each is a silent contradiction the path always wins.
 */
function fillPath(pattern: string, input: Record<string, unknown>): { path: string; rest: Record<string, unknown> } {
    const rest = { ...input };
    const path = pattern
        .split('/')
        .map((segment) => {
            if (!segment.startsWith(':')) return segment;
            const name = segment.slice(1);
            const value = rest[name];
            if (value === undefined) {
                throw new ApiError(`Missing --${name}, which "${pattern}" needs in its path.`, 400, pattern);
            }
            delete rest[name];
            return encodeURIComponent(String(value));
        })
        .join('/');
    return { path, rest };
}

/**
 * GET and DELETE carry their input in the query string; everything else in a JSON body -- matching
 * `gateway.parseInput` exactly, including that an object-valued query parameter is JSON (the
 * gateway's `decodeQueryValue` tries `JSON.parse` on every value and keeps it when it yields an
 * object). That is how `--query.status active` reaches a `find` as a real object.
 */
export async function callApi(
    apiUrl: string,
    call: Pick<DescribedCall, 'method' | 'path' | 'key'>,
    input: Record<string, unknown>,
    token?: string,
): Promise<unknown> {
    const method = call.method.toUpperCase();
    const { path, rest } = fillPath(call.path, input);

    let url = `${origin(apiUrl)}/api${path}`;
    const init: RequestInit = { method, headers: {} };
    const headers = init.headers as Record<string, string>;
    if (token !== undefined) headers['Authorization'] = `Bearer ${token}`;

    if (method === 'GET' || method === 'DELETE') {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(rest)) {
            if (value === undefined) continue;
            query.set(key, typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value));
        }
        const qs = query.toString();
        if (qs.length > 0) url += `?${qs}`;
    } else {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(rest);
    }

    let res: Response;
    try {
        res = await fetch(url, init);
    } catch (err) {
        const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined;
        throw new ApiError(`Cannot reach ${url}${cause !== undefined ? ` (${cause})` : ''}`, 0, url);
    }

    if (!res.ok) throw await readError(res, url);
    if (res.status === 204) return undefined;

    const text = await res.text();
    if (text.trim() === '') return undefined;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return text;
    }
}
