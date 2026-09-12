/**
 * A site: a hostname, whose organization owns it, and what it exposes.
 *
 * `spec/serving.md`. **The exposure is the whole security model** — a site exposes the subset of the
 * node's contracts its release declares, and a projection may serve less but never more. It is why
 * two tenants can share one process.
 *
 * The release fields are absent here on purpose: composing one is `spec/building.md`'s job and is not
 * built. A site in this slice names contracts directly, which is what the control site does anyway.
 */

import { z } from '@flybyme/mesh';

/**
 * The coarse gate, on its way out.
 *
 * `spec/identity.md` §2 replaces these with permissions and keeps only the two that are about the
 * caller existing rather than about what they may do. `admin` and `operator` are still here because
 * the contract rename (**C1**) has not happened, and a permission means nothing without a hierarchy
 * to match against. **Do not add a fifth.**
 */
export const AuthLevelSchema = z.enum(['public', 'user', 'admin', 'operator']);
export type AuthLevel = z.infer<typeof AuthLevelSchema>;

/**
 * One contract this site answers, and the gate in front of it.
 *
 * Exactly one gate. In TypeScript a union makes an ungated entry unrepresentable; in a database row
 * it cannot, so `gateOf` checks at read time and refuses — the same two-layer approach mesh takes
 * with capabilities, and the reason is that a row can be written by something that is not this
 * compiler.
 */
export const ExposedContractSchema = z.object({
    key: z.string().min(1).describe('`domain.action`, exactly as the contract declares it'),
    auth: AuthLevelSchema.optional(),
    permission: z.string().min(1).optional(),
    /** Failures this call names, beyond the transport ones every call has. */
    errors: z.array(z.string()).default([]),
});

export type ExposedContract = z.infer<typeof ExposedContractSchema>;

export const SiteSchema = z.object({
    /**
     * The hostname, normalised.
     *
     * Unique globally, not per organization: a hostname resolves to one site or the platform has to
     * guess, and guessing is one tenant receiving another's traffic.
     */
    host: z.string().min(1),

    /**
     * Whose site it is.
     *
     * Called `organizationId` and not `tenantId`, which settles **B2** in the direction the
     * membership already went. One value under two names is what the previous gate had to carry into
     * every handler.
     */
    organizationId: z.string().min(1),

    title: z.string().default(''),
    description: z.string().default(''),

    /** What this hostname answers. The subset, never the node's whole mounted set. */
    contracts: z.array(ExposedContractSchema).default([]),
});

export type Site = z.infer<typeof SiteSchema>;

/** The gate an entry declares, in the one shape everything downstream reads. */
export type Gate =
    | { readonly kind: 'auth'; readonly level: AuthLevel }
    | { readonly kind: 'permission'; readonly permission: string };

/**
 * Read an entry's gate, or refuse.
 *
 * **Throws rather than defaulting, in both directions.** An entry with no gate must never quietly
 * mean open, and an entry with two means the narrower one is decorative — which is worse, because it
 * reads as more careful than it is.
 */
export function gateOf(entry: ExposedContract): Gate {
    if (entry.auth !== undefined && entry.permission !== undefined) {
        throw new Error(
            `${entry.key} declares both auth and permission. One gate per entry: two would mean the `
            + `narrower one is decorative.`,
        );
    }

    if (entry.auth !== undefined) return { kind: 'auth', level: entry.auth };
    if (entry.permission !== undefined) return { kind: 'permission', permission: entry.permission };

    throw new Error(
        `${entry.key} is exposed with no gate. Declare auth ('public' | 'user' | 'admin' | `
        + `'operator') or a permission — an omitted gate must never mean open.`,
    );
}
