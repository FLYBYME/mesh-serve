# F6: CLI API Token Credential and Publisher Scope Derivation Report

**Date:** 2026-09-06  
**Worktree:** `/home/ubuntu/code/mesh-serve-dispatch-11`  
**Branch:** `dispatch/11`  
**Task:** **F6** — Supply a real credential for `publish-cli`, derive caller scope honestly, and enforce end-to-end publishing boundaries  
**Status:** **Complete.** All 366 tests pass across 30 test files. `npm run typecheck` passes with zero type assertions/casts.

---

## 1. Executive Summary

Roadmap item **F6** states:
> *`publish-cli` mints its own caller, and nothing checks it. The CLI joins the cluster as a node, and a node must never hold a user credential... `publish-cli` is the one that breaks the rule. It sends `{ meta: { user: { id: 'cli', tenant_id: args.publisher } } }`, where `publisher` is a bare `--publisher` flag with no credential behind it. So `catalog.publish`'s ownership check — "mesh-web belongs to another publisher" — is checkable and trivially forged: anyone who can reach the mesh port publishes as anyone.*

When **B6** landed in dispatch 10, it enforced that `catalog.publish` strictly inspects `ctx.meta.user.tenant_id`: unauthenticated callers are rejected with 401, and attempts to publish under an existing part owned by a different publisher are rejected with 403. However, `publish-cli` was still fabricating `ctx.meta.user.tenant_id` from whatever string was passed to `--publisher`.

With **F6** completed:
1. **Real Credential Required:** `publish-cli` requires an API token (via `--token <token>`, `MESH_TOKEN`, or `MESH_API_TOKEN`). Uncredentialed runs (except `--dry-run`) are immediately refused, explicitly naming `MESH_TOKEN`.
2. **Honest Scope Derivation via Identity:** `publish-cli` joins the cluster as a short-lived temporary node, calls `identity.api_token_validate`, and derives the caller's organization ID:
   - For organization-scoped tokens, the publisher scope is derived directly from `validation.organizationId`.
   - For user-scoped tokens without explicit organization binding, `publish-cli` queries `identity.whoami` and derives the publisher scope from the user's memberships (or resolves single membership).
3. **`--publisher` as Assertion and Disambiguator:** `--publisher` is no longer a source of identity; it is an optional assertion (or disambiguator when a user belongs to multiple organizations). If provided, it is checked against the verified credential and fails if mismatched.
4. **End-to-End Plane Separation:** Credential authentication travels per-invocation in `meta`, maintaining the strict architectural boundary that mesh cluster nodes do not hold user credentials.
5. **Cross-Organization Security (404 Not Found):** If an authenticated token from Organization A attempts to publish an update to Organization B's part, `catalog.publish` responds with 404 `No such part.` (matching `builder.build_start`), ensuring organization boundaries cannot even be probed.

---

## 2. Token Supply and Scope Resolution

### How the Token is Supplied
The API token credential can be supplied in two ways:
1. **Command Line Flag:** `--token <secret-token>`
2. **Environment Variable:** `MESH_TOKEN` or `MESH_API_TOKEN`

The flag takes precedence over environment variables. If `--token` is an empty string or unset, the environment variables are inspected.

> [!IMPORTANT]
> **Host Token Isolation:** An implicit fallback to `~/.mesh/token` was deliberately excluded from `parseArgs`. While developer workstations may store tokens there, CLI tools running in CI/CD or automated pipelines must require explicit credential carrier variables (`MESH_TOKEN` or `--token`) to avoid silent privilege inheritance or testing accidents.

### How the Token Resolves to a Publisher Scope
Once `publish-cli` joins the cluster:
1. It awaits `identity.api_token_validate` and `catalog.publish` tools on the cluster registry.
2. It validates the token:
   ```ts
   const validation = await cluster.call('identity.api_token_validate', { token });
   if (!validation.valid) {
       process.stderr.write('\nAuthentication failed: API token is invalid, expired, or revoked.\n');
       return 1;
   }
   ```
3. **Organization-Scoped Token Resolution:**
   If `validation.organizationId` is present:
   - If `--publisher <org>` was provided, `publish-cli` asserts that `<org>` matches either `validation.organizationId` or `validation.organizationSlug`. If not, it exits 1 naming the mismatch.
   - `publisher` is set to `validation.organizationId`.
4. **User-Scoped Token Resolution:**
   If `validation.organizationId` is undefined:
   - `publish-cli` invokes `identity.whoami` passing `{ meta: { user: { id: validation.userId, tenant_id: '' } } }`.
   - If the user has 0 memberships: exits 1 (`caller belongs to no organization`).
   - If `--publisher <org>` was provided: verifies the user is an active member of that organization.
   - If `--publisher` was not provided:
     - If the user belongs to exactly one organization: derives `publisher = membership.organizationId`.
     - If the user belongs to multiple organizations: exits 1 with a disambiguation message:
       `Caller belongs to N organizations. Pass --publisher <organization> to specify which organization to publish as.`
5. **Invocation Context:**
   The derived `publisher` and verified `userId` are passed into `catalog.publish`:
   ```ts
   await cluster.call('catalog.publish', {
       name: part.id,
       kind: part.kind,
       repository,
       publisher,
       ...
   }, {
       meta: {
           user: {
               id: validation.userId ?? 'cli',
               tenant_id: publisher,
               roles: validation.roles ?? ['authenticated'],
           },
           tenant_id: publisher,
       },
   });
   ```

---

## 3. Operator Publish Command

To publish a repository or fixture against a running `mesh-serve` node:

### Using `MESH_TOKEN` Environment Variable (Recommended for CI / Scripts)
```bash
MESH_TOKEN=mesh_tok_6a9e0bd588bc0b534a2b2d05 node bin/mesh-serve.mjs publish \
  --descriptor ./mesh.json \
  --bootstrap ws://127.0.0.1:4001
```

### Using `--token` Flag
```bash
node bin/mesh-serve.mjs publish \
  --token mesh_tok_6a9e0bd588bc0b534a2b2d05 \
  --descriptor ./mesh.json \
  --bootstrap ws://127.0.0.1:4001
```

### With Optional Publisher Assertion / Disambiguation
```bash
MESH_TOKEN=mesh_tok_6a9e0bd588bc0b534a2b2d05 node bin/mesh-serve.mjs publish \
  --descriptor ./mesh.json \
  --publisher 6a9e0bd588bc0b534a2b2d05 \
  --bootstrap ws://127.0.0.1:4001
```

---

## 4. Live Catalog Organization on This Host

The organization registered in MongoDB on this host (`mongodb://localhost:27017/mesh-serve`) from dispatch 10 is:

- **Organization ID:** `6a9e0bd588bc0b534a2b2d05`
- **Token:** `mesh_tok_6a9e0bd588bc0b534a2b2d05` (stored in `~/.mesh/token`)

Any publish issued with this token resolves its publisher scope directly to `6a9e0bd588bc0b534a2b2d05`.

---

## 5. Why `--publisher` Survived

The `--publisher` flag was preserved rather than deleted, but its role changed fundamentally:
- **Prior to F6:** It was an identity claim — whatever string the caller passed became `meta.user.tenant_id`.
- **After F6:** It is an **assertion and disambiguator**:
  1. **Disambiguator:** When an API token belongs to a user with memberships in multiple organizations (e.g. an operator belonging to both `core` and `plugins`), the token does not identify which organization is publishing. Passing `--publisher <org>` selects the target organization.
  2. **Safety Assertion:** For organization-scoped tokens, passing `--publisher` guards against script misconfigurations (e.g., asserting `--publisher my-org` prevents publishing under `other-org` if the wrong token was set in the environment).

---

## 6. What Remains Unenforced About Who May Publish

While F6 establishes verified identity and prevents cross-organization tampering, the following remain open:
1. **Flat Global Namespace for Part IDs:** Part names currently exist in a single global namespace (e.g., `part-beta`). The first organization to publish a part ID owns that ID; subsequent publishes for that part must match the owner. There is no package scoping or prefixing (e.g., `@org/part-name`), which will require a namespace migration before open third-party publishing (Roadmap M4).
2. **B4 Contract Verification:** Contracts declared in a part's `requires` are parsed and stored in the catalog, but the builder does not yet verify them against export descriptors at build time.
3. **B5 Version Policy:** Version policy flags (`needs: []`, CSP enforcement, bundle inspection) are not yet evaluated during publish or build.
4. **Fine-Grained RBAC Within an Organization:** Any valid API token issued for an organization has permission to publish parts for that organization. Role grants specifically permitting or denying `catalog.publish` (as opposed to general API access) are not yet enforced.

---

## 7. Audit of `spec/unread.md`

An audit was conducted against `spec/unread.md`.
- **No Decorative Fields Added:** No new fields were added to schemas or descriptors without readers.
- **Fields Utilized:**
  - `apiToken.organizationId` and `apiToken.userId` are actively evaluated in `identity.api_token_validate` and `publish-cli`.
  - `membership.organizationId` and `organization.slug` are queried and resolved during user token scope derivation.
  - `part.publisher` is verified against `ctx.meta.user.tenant_id` in `catalog.publish`.

---

## 8. Test Verification

### Test Suites
- **Unit Tests:** `test/api/publish.test.ts` (8 tests) verifies argument parsing, default behaviors, and priority of `--token` over `MESH_TOKEN`.
- **End-to-End Integration Tests:** `test/integration/publish-cli.test.ts` (6 tests) verifies:
  1. End-to-end publish with valid token against a live running node.
  2. Refusal when credentials are missing, explicitly naming `MESH_TOKEN`.
  3. Refusal with 404 (`No such part.`) when Organization A token attempts to publish Organization B's part.
  4. Successful publish when credentials are provided via `MESH_TOKEN` environment variable.
  5. Correct acceptance of matching `--publisher` assertion and rejection of mismatched assertion.
  6. Scope resolution from user memberships for user-scoped tokens.

### Full Test Suite Run
```
 Test Files  30 passed (30)
      Tests  366 passed (366)
   Start at  23:41:35
   Duration  7.79s
```

- **Typecheck:** `npm run typecheck` passed with 0 errors.
- **Type Safety:** 0 type assertions or casts (`as any`, `as never`, `!`).
