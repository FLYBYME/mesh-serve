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
 * A `MeshError` already carries the right status and code.
 *
 * Anything else becomes a 500 with a generic message, deliberately: a thrown message may hold
 * internal detail — a mongo error, a connection string — that must never reach a client. The real
 * error goes to the log instead.
 */
export function toHttpError(error: unknown): { status: number; body: ErrorBody } {
    if (error instanceof DeclaredFailure) {
        return {
            status: error.status,
            body: { error: error.declaredName, message: error.message, declared: true },
        };
    }

    if (error instanceof MeshError) {
        return { status: error.status, body: { error: error.code, message: error.message } };
    }

    return { status: 500, body: { error: 'INTERNAL_ERROR', message: 'Internal server error' } };
}
