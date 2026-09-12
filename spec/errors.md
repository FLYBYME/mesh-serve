# Errors

**What a refusal is on the wire, and why it is one shape.**

A projection's job is to pass a refusal through whole. This document is the contract for doing that,
and it is short on purpose: every rule here was found by a real client talking to a real server, and
none of them could have been found by either side's tests alone.

**None of this is built.** The codes and the shapes below were read out of `src-dump/`, the deleted
implementation, and are kept because each one was paid for.

---

## 1. One shape

```ts
interface ErrorBody {
    readonly error: string;      // a stable code, switched on
    readonly message: string;    // a sentence, shown to a person
    readonly declared?: true;    // present only for a failure the contract named
}
```

**A client branches on `error` and never on the text of `message`.** A message is allowed to improve;
a code is not allowed to change.

---

## 2. Three kinds of failure, and they are different on the wire

| kind | thrown as | `declared` | who is at fault |
| --- | --- | --- | --- |
| **transport** | by the projection | absent | the caller, or nobody |
| **stated** | `MeshError` from a handler | absent | the caller |
| **declared** | `DeclaredFailure` from a handler | **`true`** | the caller, and the contract said so |

### Why `declared` is explicit

**Found the moment a real browser called a real API.** Every gate refusal was arriving at the client as
a *declared* failure. The server answered `401 { error: 'UNAUTHENTICATED', message }`, and the client's
rule for *the site named this failure itself* was **a body with a string `error`** — which that is.

Two designs, made on opposite sides of the wire, agreeing on a shape and meaning different things by
it. **Neither side was wrong alone, and neither side's tests could see it:** the client's fake server
produced only one of the two shapes, and the server's tests never parsed their own output the way a
client does. One real request found it.

So the flag is explicit rather than inferred from a status. A site is free to answer a declared failure
with whatever status suits it, and the caller still knows which kind it is.

**This is the argument for an integration test, in a single bug.**

### Declared failures are part of the contract

An exposure entry carries `errors: string[]`, declared there rather than derived from the handler.
**Which failures a caller must handle must not change silently when a handler is edited.** They reach
the generated client as a literal union, so a caller switching on `error` is checked at compile time.

---

## 3. `instanceof` is not an answer, and a hosted service always is one

A `--service` is a separate npm package with its own `node_modules/@flybyme/mesh`, so the `MeshError` it
throws is a **different class object** from the one this layer imported. `instanceof` said no, and
every deliberate 400 a hosted application raised reached its own users as
`500 INTERNAL_ERROR — Internal server error`.

Measured: flowboard's `project.git_info` refusing *"Either id or repoPath must be provided"* arrived as
a 500 with the sentence removed.

**It is the same defect as roadmap F19**, where zod's `instanceof` failed across copies and would have
broken every paged read, and the fix is the same shape: **read the structure, not the identity.**

```ts
const isStatedFailure = (e: unknown): e is { code: string; status: number; message: string } =>
    e instanceof Error
    && typeof (e as { code?: unknown }).code === 'string'
    && (e as { code: string }).code !== ''
    && typeof (e as { status?: unknown }).status === 'number'
    && (e as { status: number }).status >= 400
    && (e as { status: number }).status <= 599;
```

**The test is tight on purpose, because the alternative failure is worse than a 500.** A thrown message
may carry a connection string or a query, and this is the one place deciding whether a message reaches
the internet. So a candidate must be an `Error` carrying **both** a string `code` and an integer
`status` in the HTTP error range — `MeshError`'s shape and very little else:

| | `code` | `status` | forwarded |
| --- | --- | --- | --- |
| `MeshError` | string | 4xx/5xx | yes |
| `MongoServerError` | **numeric** | none | no |
| node's `ENOENT` | string | none | no |
| an undici failure | none | none | no |

`instanceof` stays as the first check for the ordinary same-copy case, where it is exact.

**Anything not matching is a 500 with a fixed sentence and nothing of the original.** That is the
default, and it is the safe one.

---

## 4. The codes

Transport failures, produced by a projection rather than by a handler.

| code | status | means |
| --- | --- | --- |
| `NO_SITE` | 404 | the connection resolved to no site. Never a default — [serving.md](./serving.md) §3 |
| `NO_ROUTE` | 404 | this site serves nothing at that path |
| `METHOD_NOT_ALLOWED` | 405 | the path exists, the method does not |
| `INTERNAL_CONTRACT` | 404 | the contract exists and is not exposed. Refused before the body is read |
| `EXPOSURE_MISMATCH` | 404 | the site does not list this contract, though the node has mounted it |
| `UNAUTHENTICATED` | 401 | no caller, and this needs one |
| `PROVISIONAL_ACCOUNT` | 403 | the account has not been claimed. Only `identity.set_password` |
| `FORBIDDEN` | 403 | a caller, and not this one |
| `ORGANIZATION_REQUIRED` | 400 | no scope could be chosen — [identity.md](./identity.md) §8 |
| `NO_SCOPE` | 400 | a scoped read with no resolved scope |
| `INVALID_JSON` | 400 | the body is not JSON |
| `INVALID_INPUT` | 400 | the body is JSON and does not match the input schema |
| `BODY_TOO_LARGE` | 413 | over the limit, refused without buffering |
| `RELEASE_UNAVAILABLE` | 503 | the site names a release whose artifacts are not here |
| `NO_EVENTS` | 400 | a stream was requested on a site exposing none |
| `INTERNAL_ERROR` | 500 | everything else, with the original discarded |

**`INTERNAL_CONTRACT` and `EXPOSURE_MISMATCH` are both 404 and both distinct from `NO_ROUTE`.** The
distinction is not for the caller — it is for whoever reads the log. *"No such route"* when the route
exists on a different site has cost afternoons.

---

## 5. Rules

1. **A refusal carries a code and a sentence, and both reach the caller.** A status code with the
   reason thrown away is the single most common way this platform has wasted somebody's afternoon.
2. **A projection translates into its protocol's failure shape and never replaces the content.** SMTP
   has reply codes, git has its own sideband, IMAP has `NO` and `BAD`. The code and the sentence
   survive the translation.
3. **Never report a refusal as a success with an empty result.** An empty list and *"you may not read
   this"* are different answers, and a UI cannot tell them apart.
4. **Never widen a 4xx into a 500.** §3 exists entirely because that happened.
5. **Never narrow a 500 into a 4xx.** A handler that failed unexpectedly did not refuse the caller.
6. **A refusal must not confirm what it refuses.** Naming an organization the caller is not a member of
   answers 404, not 403 — [identity.md](./identity.md) §8, case 2.
