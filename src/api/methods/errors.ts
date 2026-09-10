/**
 * How a thrown thing becomes a response.
 *
 * Moved from mesh-api unchanged in substance, because the distinction it draws was found by running
 * a real browser against a real API and could not have been found any other way.
 */

import { MeshError } from '@flybyme/mesh';

/** The one error shape this layer returns, so a client can branch on `error` without matching text. */
export interface ErrorBody {
    readonly error: string;
    readonly message: string;
    /** Present and true only for a failure the contract declared. See `DeclaredFailure`. */
    readonly declared?: true;
}

/**
 * A failure this contract declared, thrown by a handler.
 *
 * **Found the moment a real browser called a real API**: every gate refusal was arriving at the
 * client as a *declared* failure. The server answered 401 with `{ error: 'UNAUTHENTICATED', message }`,
 * and the client's rule for *the site named this failure itself* was **a body with a string `error`**
 * — which that is. Two designs, made on opposite sides of the wire, agreeing on a shape and meaning
 * different things by it.
 *
 * Neither side was wrong alone, and neither side's tests could see it: the client's fake server only
 * ever produced one of the two shapes, and the server's tests never parsed their own output the way a
 * client does. It took one real request to find — which is the argument for integration in a single
 * bug, and the reason this repository's spine test exists.
 *
 * So the two are different on the wire now, and `declared: true` is **explicit rather than inferred
 * from a status**: a site is free to answer a declared failure with whatever status suits it, and the
 * caller still knows which kind it is.
 */
export class DeclaredFailure extends Error {
    /**
     * The declared name, e.g. `title_taken`.
     *
     * Not `name`: `Error.name` already exists and means something else, and a subclass overwriting it
     * breaks every stack-trace header and every check that reads it.
     */
    readonly declaredName: string;
    readonly status: number;

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
 * A `--service` is a separate npm package with its own `node_modules/@flybyme/mesh`, so the
 * `MeshError` it throws is a *different class object* from the one this file imported. `instanceof`
 * said no, and every deliberate 400 a hosted application raised reached its own users as
 * `500 INTERNAL_ERROR — Internal server error`. Measured: flowboard's `project.git_info` refusing
 * `Either "id" or "repoPath" must be provided` arrived as a 500 with the sentence removed.
 *
 * It is the same defect as roadmap F19, where zod's `instanceof` failed across copies and would have
 * broken every paged read, and the fix is the same shape: **read the structure, not the identity.**
 *
 * The structure is tight on purpose, because the alternative failure is worse than a 500. A thrown
 * message may carry a connection string or a query, and this is the one place that decides whether a
 * message reaches the internet — so a candidate must be an `Error` carrying **both** a string `code`
 * and an integer `status` in the HTTP error range. That is `MeshError`'s shape and very little else:
 * a `MongoServerError` has a *numeric* `code`, node's own `ENOENT` has a string `code` and no
 * `status`, and an undici failure has neither. A thing has to look like a stated HTTP refusal to be
 * forwarded as one.
 *
 * `instanceof` stays as the first check for the ordinary same-copy case, where it is exact.
 */
const isStatedFailure = (error: unknown): error is { code: string; status: number; message: string } => {
    if (!(error instanceof Error)) return false;
    const candidate = error as unknown as { code?: unknown; status?: unknown };
    return typeof candidate.code === 'string'
        && candidate.code !== ''
        && typeof candidate.status === 'number'
        && Number.isInteger(candidate.status)
        && candidate.status >= 400
        && candidate.status <= 599;
};

/** The same reasoning for a declared failure, whose portable mark is a string `declaredName`. */
const isDeclared = (error: unknown): error is { declaredName: string; status: number; message: string } =>
    error instanceof Error
    && typeof (error as unknown as { declaredName?: unknown }).declaredName === 'string'
    && typeof (error as unknown as { status?: unknown }).status === 'number';

/**
 * A `MeshError` already carries the right status and code.
 *
 * Anything else becomes a 500 with a generic message, deliberately: a thrown message may hold
 * internal detail — a mongo error, a connection string — that must never reach a client. The real
 * error goes to the log instead.
 */
export function toHttpError(error: unknown): { status: number; body: ErrorBody } {
    if (error instanceof DeclaredFailure || isDeclared(error)) {
        return {
            status: error.status,
            body: { error: error.declaredName, message: error.message, declared: true },
        };
    }

    if (error instanceof MeshError || isStatedFailure(error)) {
        return { status: error.status, body: { error: error.code, message: error.message } };
    }

    return { status: 500, body: { error: 'INTERNAL_ERROR', message: 'Internal server error' } };
}
