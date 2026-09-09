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
    const headers = {
        host,
        ...(ticket === undefined ? {} : { authorization: `Bearer ${ticket}` }),
    };

    /**
     * **A person points this at the site, not at the api, and that has to work.**
     *
     * `flowboard.localhost` is where the *page* is. The api is somewhere else — a different port,
     * possibly a different origin — and expecting somebody to know that before they have asked the
     * platform anything is the CLI demanding to be told what it is for.
     *
     * A browser has the same problem and the page already solves it: the cdn writes
     * `data-api="…"` into the document, which is how a bundle knows where to call. So this asks the
     * same question a browser asks. Point it at what you would open, and it finds the rest.
     */
    /**
     * **"Nothing is listening" and "nothing serves this hostname" are different problems.**
     *
     * They produced one message, which then guessed wrong: it told somebody whose node was plainly
     * running to start a node. A 404 means something answered — the platform is up and no site
     * claims this host, which is one command away. A refused connection means nothing is there at
     * all, which is a different command.
     */
    let answered = false;

    for (const origin of await candidateOrigins(host, headers)) {
        const url = `${origin}/_describe`;

        let response: Response;
        try {
            response = await fetch(url, { headers });
        } catch {
            continue;
        }

        answered = true;
        if (response.status === 404) continue;
        if (!response.ok) throw new CliError(`${url} answered ${String(response.status)}.`);

        const text = await response.text();
        try {
            return JSON.parse(text) as Descriptor;
        } catch {
            // HTML: this origin is the cdn, not the api. Keep looking rather than reporting a JSON
            // parse error, which describes the symptom and not the situation.
            continue;
        }
    }

    if (answered) {
        throw new CliError(
            `A node is running, and no site serves ${host}.`,
            `Seed one:\n\n`
            + `  mesh-serve seed --org-slug <slug> --org-name "<name>" \\\n`
            + `    --host ${host.split(':')[0] ?? host} \\\n`
            + `    --api http://${host.split(':')[0] ?? host}:5005 \\\n`
            + `    --app-repo <a git url or bare repo> --parts <part>\n\n`
            + `A site is a hostname, a release, and what it may call. Until one exists the api has `
            + `nothing to resolve this Host header to.`,
        );
    }

    throw new CliError(
        `Nothing is listening for ${host}.`,
        'Start a node:\n\n  mesh-serve node --ws 4001 --cdn 8080 --api 5005\n\n'
        + 'Then point --host at the site as you would open it — the page names its own api and this '
        + 'follows that.',
    );
}

/**
 * Where the api might be, best guess first.
 *
 * The site's own origin, then whatever its page declares. Ordered so a host that *is* the api costs
 * one request, and a host that is the cdn costs two.
 */
async function candidateOrigins(host: string, headers: Record<string, string>): Promise<readonly string[]> {
    const direct = originOf(host);
    const declared = await declaredApi(direct, headers);
    return declared === undefined || declared === direct ? [direct] : [direct, declared];
}

/** `data-api="http://…"` from the served page — the same value the browser's bundle reads. */
async function declaredApi(origin: string, headers: Record<string, string>): Promise<string | undefined> {
    try {
        const response = await fetch(`${origin}/`, { headers });
        if (!response.ok) return undefined;
        const html = await response.text();
        return /data-api="([^"]+)"/.exec(html)?.[1]?.replace(/\/$/, '');
    } catch {
        return undefined;
    }
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
