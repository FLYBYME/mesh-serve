/**
 * Talking to a site over HTTP.
 *
 * **The CLI is a client of the API and of nothing else** (`spec/cli.md`). No database handle, no
 * joining the mesh to assert an identity, no second code path that only the terminal can reach. A
 * browser and a terminal make the same call.
 */

import { REFUSALS } from '../serve/methods/errors.js';

export interface ClientOptions {
    /** `127.0.0.1` by default, because the control site is what exists on a machine that just booted. */
    readonly host: string;
    /** Where the api actually listens. Separate from the hostname, which is what names the *site*. */
    readonly origin: string;
    readonly ticket?: string | undefined;
}

/**
 * A refusal that came back from a site, carrying what the site said.
 *
 * **The message is the sentence the server sent, not a status.** *"Request failed with status code
 * 403"* is the failure mode `spec/cli.md` §5 exists to prevent — the wire carries a code and a
 * sentence, and the terminal shows the sentence.
 */
export class Refused extends Error {
    public readonly code: string;
    public readonly status: number;

    constructor(code: string, message: string, status: number) {
        super(message);
        this.name = 'Refused';
        this.code = code;
        this.status = status;
    }
}

interface Errorish {
    readonly error?: unknown;
    readonly message?: unknown;
}

/**
 * One call.
 *
 * The `Host` header is set explicitly and is **not** taken from the origin: a node serves many sites
 * and the hostname is what chooses between them, so `--host example.com` against a local origin is a
 * real and useful thing to do.
 */
export async function call(
    options: ClientOptions,
    method: string,
    path: string,
    body?: unknown,
): Promise<unknown> {
    const headers: Record<string, string> = { host: options.host, accept: 'application/json' };
    if (options.ticket !== undefined) headers['authorization'] = `Bearer ${options.ticket}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    const response = await fetch(new URL(path, options.origin), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch((error: unknown) => {
        /**
         * **Refused is not the same as ignored**, and saying so is most of this function's value.
         * Something answered and said no, which means the address is right and nothing is listening.
         */
        const detail = error instanceof Error ? error.message : String(error);
        throw new Refused(
            'NO_CONNECTION',
            `Nothing answered at ${options.origin}. Is the node running?\n  ${detail}`,
            0,
        );
    });

    const text = await response.text();
    const parsed: unknown = text === '' ? null : safeJson(text);

    if (response.ok) return parsed;

    const shape: Errorish = typeof parsed === 'object' && parsed !== null ? parsed : {};
    const code = typeof shape.error === 'string' ? shape.error : 'UNKNOWN';
    const message = typeof shape.message === 'string'
        ? shape.message
        : fallbackMessage(code, response.status, text);

    throw new Refused(code, message, response.status);
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/**
 * What to say when the body carried no sentence.
 *
 * The transport codes are already written down once, in `REFUSALS`, so a server that sent a bare
 * code still produces the same words as one that sent the whole thing. **One table, both sides** —
 * two copies of a refusal's wording is how the two drift.
 */
function fallbackMessage(code: string, status: number, raw: string): string {
    const known = (REFUSALS as Record<string, { message: string } | undefined>)[code];
    if (known !== undefined) return known.message;
    return raw === '' ? `The site refused with ${String(status)} and said nothing.` : raw;
}
