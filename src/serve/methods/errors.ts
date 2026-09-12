/**
 * How a thrown thing becomes a response.
 *
 * `spec/errors.md`. Every rule here was found by a real client talking to a real server, and none of
 * them could have been found by either side's tests alone.
 */

import { MeshError } from '@flybyme/mesh';

/** The one error shape this layer returns, so a client can branch on `error` without matching text. */
export interface ErrorBody {
    readonly error: string;
    readonly message: string;
    /** Present and true only for a failure the contract declared. */
    readonly declared?: true;
}

export interface ErrorResponse {
    readonly status: number;
    readonly body: ErrorBody;
}

/**
 * A failure this contract declared, thrown by a handler.
 *
 * **Found the moment a real browser called a real API**: every gate refusal was arriving at the
 * client as a *declared* failure. The server answered `401 { error: 'UNAUTHENTICATED', message }`,
 * and the client's rule for *the site named this failure itself* was **a body with a string
 * `error`** — which that is.
 *
 * Two designs, made on opposite sides of the wire, agreeing on a shape and meaning different things
 * by it. Neither side was wrong alone and neither side's tests could see it: the client's fake
 * server produced one of the two shapes, and the server's tests never parsed their own output the
 * way a client does.
 *
 * So the two are different on the wire, and `declared` is **explicit rather than inferred from a
 * status**: a site may answer a declared failure with whatever status suits it and the caller still
 * knows which kind it is.
 */
export class DeclaredFailure extends Error {
    /**
     * The declared name, e.g. `title_taken`.
     *
     * Not `name`: `Error.name` already exists and means something else, and a subclass overwriting
     * it breaks every stack-trace header and every check that reads it.
     */
    public readonly declaredName: string;
    public readonly status: number;

    constructor(name: string, message: string, status = 400) {
        super(message);
        this.name = 'DeclaredFailure';
        this.declaredName = name;
        this.status = status;
    }
}

/**
 * **`instanceof` is not an answer across module copies, and a hosted service always is one.**
 *
 * A hosted service is a separate npm package with its own `node_modules/@flybyme/mesh`, so the
 * `MeshError` it throws is a *different class object* from the one this file imported. `instanceof`
 * said no, and every deliberate 400 a hosted application raised reached its own users as
 * `500 INTERNAL_ERROR — Internal server error`. Measured: flowboard's `project.git_info` refusing
 * *"Either id or repoPath must be provided"* arrived as a 500 with the sentence removed.
 *
 * **Read the structure, not the identity.** The test is tight on purpose, because the alternative
 * failure is worse than a 500: a thrown message may carry a connection string or a query, and this
 * is the one place that decides whether a message reaches the internet. So a candidate must be an
 * `Error` carrying **both** a string `code` and an integer `status` in the HTTP error range — that
 * is `MeshError`'s shape and very little else. A `MongoServerError` has a *numeric* `code`, node's
 * `ENOENT` has a string `code` and no `status`, and an undici failure has neither.
 */
function isStatedFailure(error: unknown): error is { code: string; status: number; message: string } {
    if (!(error instanceof Error)) return false;
    // Reading two properties off an `Error` that does not declare them. Not a cast past a type that
    // exists -- there is no type for "some other copy of MeshError", which is the whole problem.
    const candidate = error as Error & { code?: unknown; status?: unknown };
    return typeof candidate.code === 'string'
        && candidate.code !== ''
        && typeof candidate.status === 'number'
        && Number.isInteger(candidate.status)
        && candidate.status >= 400
        && candidate.status <= 599;
}

function isDeclared(error: unknown): error is DeclaredFailure {
    return error instanceof Error
        && typeof (error as { declaredName?: unknown }).declaredName === 'string'
        && typeof (error as { status?: unknown }).status === 'number';
}

/**
 * Turn anything thrown into a response.
 *
 * **Anything that does not match is a 500 with a fixed sentence and nothing of the original.** That
 * is the default and it is the safe one.
 *
 * `onUnmapped` is how the operator still gets it. Stripping the detail is right for the *caller* —
 * a thrown message may carry a connection string — and wrong for the person running the node, who
 * otherwise watches a 500 go past with no way to find out what it was. The previous version had no
 * such hook and every unexpected failure became `Internal server error` in the log as well as on
 * the wire.
 */
export function errorResponse(error: unknown, onUnmapped?: (error: unknown) => void): ErrorResponse {
    if (isDeclared(error)) {
        return {
            status: error.status,
            body: { error: error.declaredName, message: error.message, declared: true },
        };
    }

    // The ordinary same-copy case, where `instanceof` is exact.
    if (error instanceof MeshError) {
        const status = typeof error.status === 'number' ? error.status : 500;
        return { status, body: { error: error.code, message: error.message } };
    }

    if (isStatedFailure(error)) {
        return { status: error.status, body: { error: error.code, message: error.message } };
    }

    onUnmapped?.(error);
    return { status: 500, body: { error: 'INTERNAL_ERROR', message: 'Internal server error' } };
}

/**
 * The transport refusals, produced by a projection rather than by a handler.
 *
 * Named as one table so a projection cannot invent a fifth spelling of *no*. `spec/errors.md` §4
 * carries the same list with what each one means.
 */
export const REFUSALS = {
    NO_SITE: { status: 404, message: 'No site answers on this hostname.' },
    NO_ROUTE: { status: 404, message: 'This site serves nothing at that path.' },
    METHOD_NOT_ALLOWED: { status: 405, message: 'That path does not answer this method.' },
    INTERNAL_CONTRACT: { status: 404, message: 'This contract is internal and is not served.' },
    EXPOSURE_MISMATCH: { status: 404, message: 'This site does not expose that contract.' },
    UNAUTHENTICATED: { status: 401, message: 'This needs a signed-in caller.' },
    PROVISIONAL_ACCOUNT: {
        status: 403,
        message: 'This account has not been claimed. Set a password first, and nothing else will '
            + 'be answered until you do.',
    },
    FORBIDDEN: { status: 403, message: 'This caller may not make this call.' },
    ORGANIZATION_REQUIRED: {
        status: 400,
        message: 'This needs an organization, and none could be chosen: this account belongs to '
            + 'none, or to several and the request did not say which. Name one with the '
            + 'x-organization header.',
    },
    NO_SCOPE: { status: 400, message: 'This read is scoped and no scope was resolved.' },
    INVALID_JSON: { status: 400, message: 'The body is not JSON.' },
    INVALID_INPUT: { status: 400, message: 'The body does not match this contract.' },
    BODY_TOO_LARGE: { status: 413, message: 'The body is larger than this site accepts.' },
} as const satisfies Record<string, { status: number; message: string }>;

export type RefusalCode = keyof typeof REFUSALS;

/** One refusal, optionally with a sentence that says more than the table's default. */
export function refuse(code: RefusalCode, message?: string): ErrorResponse {
    const refusal = REFUSALS[code];
    return { status: refusal.status, body: { error: code, message: message ?? refusal.message } };
}
