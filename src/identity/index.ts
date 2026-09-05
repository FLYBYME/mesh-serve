/**
 * @flybyme/mesh-identity — the `identity` ServiceModule.
 *
 * One of the four modules (mesh-web spec/service-modules.md §2), and **the only one with no
 * listener**. It answers mesh calls and emits events; mesh-api is effectively its only caller, and
 * the browser never speaks to it directly.
 *
 * ## It stands alone
 *
 * Roadmap C1.10: this is a foundation for any project that needs an API and a web front with
 * identity. **No surfdns import, ever** — that is the point of it being here rather than in a
 * product, and it is why roles are records rather than the `public | user | admin` enum surfdns
 * compiled into its source. A blog has `reader` and `author`; a trading platform has `trader` and
 * `compliance`. An enum in the framework means both of them fork it.
 *
 * ## The two things worth reading first
 *
 * **`schema/roles.ts`** — a role is a row with a *required* scope, which is what makes surfdns #26
 * structurally impossible rather than merely fixed.
 *
 * **`schema/tickets.ts`** — tickets are opaque, so there is no signing key; and revocation is a
 * poll rather than an event, because mesh delivers at-most-once (mesh-web spec/auth.md §3.1) and an
 * instance that was down when a ticket was revoked would otherwise never find out.
 */

export * from './schema/roles.js';
export * from './schema/tickets.js';
export * from './schema/principals.js';

export * from './methods/password.js';
export * from './contracts/identity.contract.js';
export * from './store.js';
export * from './module.js';
