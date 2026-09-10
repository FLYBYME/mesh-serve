/**
 * **What a thrown thing becomes on the wire — and the copy of mesh it was thrown from.**
 *
 * A `--service` is a separate npm package with its own `node_modules/@flybyme/mesh`, so its
 * `MeshError` is a different class object from this repository's. `toHttpError` asked `instanceof`,
 * got no, and turned **every deliberate refusal a hosted application made** into
 * `500 INTERNAL_ERROR — Internal server error`. Measured on the live cluster: flowboard's
 * `project.git_info` answering `Either "id" or "repoPath" must be provided` reached the caller as a
 * 500 with the sentence gone.
 *
 * Roadmap F26, and the same defect as F19 — zod's `instanceof` across copies — with the same fix:
 * read the structure, not the identity.
 *
 * The negative cases below are the whole reason the structure is narrow. This function decides
 * whether a thrown message reaches the internet, and a thrown message may carry a connection string
 * or a query.
 */

import { MeshError } from '@flybyme/mesh';
import { describe, expect, it } from 'vitest';

import { DeclaredFailure, toHttpError } from '../../src/api/methods/errors.js';

/**
 * What a hosted service's own copy of mesh produces. Re-declared rather than imported precisely
 * because importing it would make it the *same* class and test nothing — this is the shape that
 * arrives over a module boundary, and nothing about it is `instanceof` anything here.
 */
class ForeignClientError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(message: string, code = 'BAD_REQUEST', status = 400) {
        super(message);
        this.name = 'ClientError';
        this.code = code;
        this.status = status;
    }
}

describe('an error from this repository', () => {
    it('keeps its status and code', () => {
        expect(toHttpError(new MeshError({ code: 'NOT_FOUND', message: 'No such site.', status: 404 })))
            .toEqual({ status: 404, body: { error: 'NOT_FOUND', message: 'No such site.' } });
    });

    it('marks a declared failure as declared', () => {
        expect(toHttpError(new DeclaredFailure('title_taken', 'That title is in use.', 409)))
            .toEqual({ status: 409, body: { error: 'title_taken', message: 'That title is in use.', declared: true } });
    });
});

describe('an error from a hosted service, thrown through its own copy of mesh', () => {
    /** The fix. Before it, this whole block was a 500 with the message removed. */
    it('is forwarded with its own status and message', () => {
        expect(toHttpError(new ForeignClientError('Either "id" or "repoPath" must be provided')))
            .toEqual({
                status: 400,
                body: { error: 'BAD_REQUEST', message: 'Either "id" or "repoPath" must be provided' },
            });
    });

    it('keeps a non-default status', () => {
        expect(toHttpError(new ForeignClientError('That card is not yours.', 'FORBIDDEN', 403)).status)
            .toBe(403);
    });

    it('is declared when it carries a declaredName', () => {
        const foreign = Object.assign(new Error('That slug is in use.'), {
            declaredName: 'slug_taken',
            status: 409,
        });
        expect(toHttpError(foreign))
            .toEqual({ status: 409, body: { error: 'slug_taken', message: 'That slug is in use.', declared: true } });
    });
});

/**
 * **Everything that is not a stated refusal still becomes a generic 500**, which is the property the
 * narrow structure exists to keep. Each of these is a real error a real handler throws.
 */
describe('an error that only resembles one', () => {
    const opaque = { status: 500, body: { error: 'INTERNAL_ERROR', message: 'Internal server error' } };

    it('hides a mongo failure, whose code is a number', () => {
        const mongo = Object.assign(new Error('E11000 duplicate key error … mongodb://user:pw@host/db'), {
            code: 11000,
            name: 'MongoServerError',
        });
        expect(toHttpError(mongo)).toEqual(opaque);
    });

    it('hides a filesystem failure, which has a string code and no status', () => {
        const enoent = Object.assign(new Error("ENOENT: no such file or directory, open '/etc/secret'"), {
            code: 'ENOENT',
            errno: -2,
        });
        expect(toHttpError(enoent)).toEqual(opaque);
    });

    it('hides a plain error', () => {
        expect(toHttpError(new Error('connection string mongodb://user:pw@host/db'))).toEqual(opaque);
    });

    it('hides a thrown object that is not an Error at all', () => {
        expect(toHttpError({ code: 'FORBIDDEN', status: 403, message: 'nice try' })).toEqual(opaque);
    });

    it('hides a status outside the error range', () => {
        const odd = Object.assign(new Error('secret'), { code: 'OK', status: 200 });
        expect(toHttpError(odd)).toEqual(opaque);
        const nonsense = Object.assign(new Error('secret'), { code: 'X', status: 99 });
        expect(toHttpError(nonsense)).toEqual(opaque);
    });

    it('hides an empty code', () => {
        expect(toHttpError(Object.assign(new Error('secret'), { code: '', status: 400 }))).toEqual(opaque);
    });
});
