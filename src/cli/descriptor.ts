/**
 * **A site's descriptor, fetched over HTTP.**
 *
 * The CLI is a client, not a node. It does not join the mesh, does not hold the mesh key, and does
 * not call a broker — it reads `/_describe` and calls the same routes a browser calls. Everything it
 * can do, a person with a browser could do, which is the property that makes it testable and the
 * property `src/bring-up.ts` gave up by starting its own `MeshApp`.
 *
 * See `spec/cli.md` §2.
 */

/** One call, as `/_describe` reports it. A subset: what a command needs and nothing more. */
export interface Call {
    readonly key: string;
    readonly domain: string;
    readonly action: string;
    readonly description: string;
    readonly method: string;
    readonly path: string;
    readonly gate?: { readonly kind: string; readonly level?: string };
    readonly input?: unknown;
    readonly destructive?: boolean;
    readonly stream?: boolean;
}

export interface Descriptor {
    readonly application: string;
    readonly base: string;
    readonly exposure: string;
    readonly calls: readonly Call[];
}

export class CliError extends Error {
    constructor(message: string, readonly hint?: string) {
        super(message);
        this.name = 'CliError';
    }
}

/**
 * `flowboard.localhost:5005` → `http://flowboard.localhost:5005`.
 *
 * Plain http for a loopback or `.localhost` name and https otherwise, because a CLI that defaults to
 * http against a real host is one that sends a ticket in the clear the first time somebody types a
 * domain name.
 */
export const originOf = (host: string): string => {
    if (host.startsWith('http://') || host.startsWith('https://')) return host.replace(/\/$/, '');
    const bare = host.split(':')[0] ?? host;
    const local = bare === 'localhost' || bare.endsWith('.localhost')
        || bare === '127.0.0.1' || bare === '::1';
    return `${local ? 'http' : 'https'}://${host}`;
};

/**
 * Fetch what this site exposes, as this caller.
 *
 * **The ticket is sent**, because a descriptor is per-caller: a site reports what *you* may call, and
 * a CLI that asked anonymously would offer commands that then refuse. Same rule as `tools/list` in
 * `spec/mcp.md` §3.
 */
export async function fetchDescriptor(host: string, ticket?: string): Promise<Descriptor> {
    const url = `${originOf(host)}/_describe`;

    let response: Response;
    try {
        response = await fetch(url, {
            headers: {
                host,
                ...(ticket === undefined ? {} : { authorization: `Bearer ${ticket}` }),
            },
        });
    } catch (cause) {
        throw new CliError(
            `Could not reach ${url}.`,
            'Is a node running, and is --host the hostname a site is served on? '
            + 'The api resolves a site by the Host header, so an address that is not a site answers nothing.',
        );
    }

    if (response.status === 404) {
        throw new CliError(
            `No site serves ${host}.`,
            'The api resolves Host → site. A site must exist for this hostname; `mesh-serve seed` creates one.',
        );
    }
    if (!response.ok) {
        throw new CliError(`${url} answered ${String(response.status)}.`);
    }

    return await response.json() as Descriptor;
}

/**
 * Call one contract.
 *
 * Path parameters are substituted and then **removed from the body**, so a caller cannot act on one
 * record through another's URL — the same rule the api applies on the way in, applied here so the
 * two agree about which id won.
 */
export async function callContract(
    host: string,
    base: string,
    call: Call,
    input: Record<string, unknown>,
    ticket?: string,
): Promise<{ status: number; body: unknown }> {
    const rest = { ...input };
    const path = call.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => {
        const value = rest[name];
        delete rest[name];
        return encodeURIComponent(String(value ?? ''));
    });

    const query = new URLSearchParams();
    const hasBody = call.method !== 'GET' && call.method !== 'DELETE';
    if (!hasBody) {
        for (const [key, value] of Object.entries(rest)) {
            if (value !== undefined) query.set(key, typeof value === 'string' ? value : JSON.stringify(value));
        }
    }

    const url = `${originOf(host)}${base}${path}${query.size > 0 ? `?${query.toString()}` : ''}`;

    const response = await fetch(url, {
        method: call.method,
        headers: {
            host,
            'content-type': 'application/json',
            ...(ticket === undefined ? {} : { authorization: `Bearer ${ticket}` }),
        },
        ...(hasBody ? { body: JSON.stringify(rest) } : {}),
    });

    const text = await response.text();
    let body: unknown = text;
    try {
        body = text === '' ? undefined : JSON.parse(text);
    } catch {
        // Not JSON. Kept as text rather than thrown away: an error page is more useful than nothing.
    }

    return { status: response.status, body };
}
