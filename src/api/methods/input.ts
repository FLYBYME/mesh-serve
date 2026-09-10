/**
 * HTTP has one type, and contracts have many.
 *
 * Path params and query strings are always strings. A contract declaring `limit: z.number()` would
 * therefore reject `?limit=10` on a technicality that has nothing to do with the caller being wrong.
 *
 * So string-shaped input is coerced **toward what the contract already declares**, before
 * validation. This is not a second schema and not a second validation layer — the contract remains
 * the sole authority on what is valid. It is only being told the value in the type it asked for.
 * Anything the schema does not describe as a number, boolean or array passes through untouched.
 *
 * Carried forward from `archive/pre-rewrite`, which got this right.
 *
 * ## Types are recognised by name, not by class — and a tenant is why
 *
 * This used `instanceof z.ZodNumber`, against the zod this repository imports. A service mounted
 * with `--service` brings **its own copy** of zod — flowboard's contracts are built from
 * `flowboard/node_modules/zod`, a different module instance of the same version — so every
 * `instanceof` was false for every one of its fields, nothing was coerced, and
 *
 *     GET /api/cards?limit=5  →  400  limit: Expected number, received string
 *
 * while `GET /api/releases?limit=5` on the same node answered 200. Found the first time a second
 * tenant's services ran on a cluster (freeze gate V15), and it is exactly the call pagination makes
 * on every request (V4) — so it would have broken every external service's lists the day paging
 * landed, and passed every test here, because every test schema is built from this repository's zod.
 *
 * `_def.typeName` is the discriminant zod itself switches on, and it is the same string in every
 * copy. The predicates below narrow on it, so the methods called afterwards (`unwrap`, `shape`,
 * `element`) are reached through a checked type rather than a cast.
 */

import { z } from '@flybyme/mesh';

/** zod's own discriminant for a schema, read without trusting which copy of zod built it. */
function kindOf(schema: z.ZodTypeAny): string | undefined {
    const def: unknown = schema._def;
    if (typeof def !== 'object' || def === null || !('typeName' in def)) return undefined;
    return typeof def.typeName === 'string' ? def.typeName : undefined;
}

const isObject = (s: z.ZodTypeAny): s is z.AnyZodObject => kindOf(s) === 'ZodObject';
const isOptional = (s: z.ZodTypeAny): s is z.ZodOptional<z.ZodTypeAny> => kindOf(s) === 'ZodOptional';
const isNullable = (s: z.ZodTypeAny): s is z.ZodNullable<z.ZodTypeAny> => kindOf(s) === 'ZodNullable';
const isDefault = (s: z.ZodTypeAny): s is z.ZodDefault<z.ZodTypeAny> => kindOf(s) === 'ZodDefault';
const isEffects = (s: z.ZodTypeAny): s is z.ZodEffects<z.ZodTypeAny> => kindOf(s) === 'ZodEffects';
const isArray = (s: z.ZodTypeAny): s is z.ZodArray<z.ZodTypeAny> => kindOf(s) === 'ZodArray';
const isNumber = (s: z.ZodTypeAny): boolean => kindOf(s) === 'ZodNumber';
const isBoolean = (s: z.ZodTypeAny): boolean => kindOf(s) === 'ZodBoolean';
const isRecordLike = (s: z.ZodTypeAny): boolean => {
    const kind = kindOf(s);
    return kind === 'ZodObject' || kind === 'ZodRecord';
};

/** The field map of an object schema, looking through optional, nullable and default wrappers. */
function shapeOf(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> | undefined {
    const inner = unwrap(schema);
    return isObject(inner) ? inner.shape : undefined;
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
    let current = schema;
    // Bounded rather than `while (true)`: a self-referential schema would otherwise spin here, and
    // a request thread spinning is worse than a request failing.
    for (let i = 0; i < 10; i++) {
        if (isOptional(current) || isNullable(current)) {
            current = current.unwrap();
            continue;
        }
        if (isDefault(current)) {
            current = current.removeDefault();
            continue;
        }
        if (isEffects(current)) {
            current = current.innerType();
            continue;
        }
        break;
    }
    return current;
}

export function coerceToSchema(
    schema: z.ZodTypeAny,
    input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
    const shape = shapeOf(schema);
    if (shape === undefined) return { ...input };

    const out: Record<string, unknown> = { ...input };
    for (const [key, value] of Object.entries(input)) {
        const field = shape[key];
        if (field === undefined) continue;
        out[key] = coerce(unwrap(field), value);
    }
    return out;
}

function coerce(field: z.ZodTypeAny, value: unknown): unknown {
    if (isArray(field)) {
        // `?tag=a&tag=b` arrives as an array; `?tag=a` arrives as a scalar. A contract asking for an
        // array should get one either way.
        const items = Array.isArray(value) ? value : [value];
        return items.map((item) => coerce(unwrap(field.element), item));
    }

    if (typeof value !== 'string') return value;

    if (isNumber(field)) {
        // An empty string is not zero. Leave it and let the schema reject it with a real message.
        if (value.trim() === '') return value;
        const n = Number(value);
        return Number.isNaN(n) ? value : n;
    }

    if (isBoolean(field)) {
        if (value === 'true') return true;
        if (value === 'false') return false;
        return value;
    }

    /**
     * **An object in a query string is JSON, and nothing was decoding it.**
     *
     * Numbers, booleans and arrays were coerced; objects and records were not. That gap is not
     * cosmetic, because the one field it hits is the one every generated `find` sends:
     * `defineCrud`'s `query`. The client emits `GET /parts?query=%7B%7D` — which is `{}` — and the
     * api handed the schema the literal string `"{}"`, answering:
     *
     *     query: Expected object, received string
     *
     * So **every list call from a browser failed**, on every collection, the moment F2 exposed one.
     * Found by the first console to get past authentication — the layer above had been refusing
     * these calls for other reasons and hiding it.
     *
     * Parsed leniently: a string that is not JSON is passed through unchanged so the schema rejects
     * it with its own message. A coercion that throws would turn a bad query into a 500, and the
     * whole point of coercing at the boundary is that a bad request is a 400 naming the field.
     */
    if (isRecordLike(field)) {
        const text = value.trim();
        if (!text.startsWith('{') && !text.startsWith('[')) return value;

        try {
            return JSON.parse(text);
        } catch {
            return value;
        }
    }

    return value;
}

/**
 * A validation failure a client can act on.
 *
 * The broker validates too, but it wraps the failure in a plain `Error`, which maps to a 500 and
 * hides the reason. Validating at the boundary with the contract's own schema is what makes a bad
 * request a 400 that names the field.
 */
export function formatZodError(error: z.ZodError): string {
    return error.issues
        .map((issue) => {
            const path = issue.path.join('.');
            return path === '' ? issue.message : `${path}: ${issue.message}`;
        })
        .join('; ');
}
