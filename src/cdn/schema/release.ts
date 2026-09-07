/**
 * A release: a kernel and a set of parts that are known to work together.
 *
 * **What runs, separated from where it runs.** A site used to carry its own composition, which made
 * three things impossible at once:
 *
 * - **staging and production could not be proved identical.** Two site rows naming `^1.4` resolve
 *   independently and at different times, so "the same code" was a claim nobody could check. Both
 *   pointing at release `sha256:abc…` is the same code by construction.
 * - **rollback was a re-resolution.** Now it is a write: point the site at the previous release.
 *   Nothing rebuilds, nothing re-resolves, and there is nothing to get wrong under pressure.
 * - **a hundred hostnames resolved a hundred times.** One release resolves once and every site on it
 *   shares every artifact.
 *
 * ## It is a set of artifacts, not a package
 *
 * A release does not contain a built page and is not itself an artifact. The kernel and each part
 * stay separately addressed, separately cached and separately replaced — which is what makes
 * installing an extension cheap. `index.html` is generated **per request** from site + release, so
 * SEO metadata reaches the document rather than being injected by script.
 */

import { z } from '@flybyme/mesh';

/** One resolved artifact: the exact version chosen, and the bytes it is. */
export const PinnedArtifactSchema = z.object({
    /** The exact version, never the range it was chosen for. */
    version: z.string().min(1),
    /** → artifact.digest. */
    digest: z.string().min(1),
});
export type PinnedArtifact = z.infer<typeof PinnedArtifactSchema>;

export const ReleaseSchema = z.object({
    /**
     * The identity of a release, **derived rather than minted**.
     *
     * A sha256 over the kernel, the parts and the policy, canonically ordered — so two people
     * composing the same set land on the same release without coordinating, and a release is
     * *checkable* rather than merely labelled. An assigned id would let two rows describe one
     * composition and nothing could tell.
     *
     * Beside the framework's own `id`, which is minted and means nothing here. See
     * `spec/building.md` §4a for why a collection cannot take a natural key.
     */
    hash: z.string().min(1),

    /** A label for people. Never an identity: two releases may share one, `hash` cannot. */
    name: z.string().default(''),

    /**
     * Who composed it.
     *
     * → organization. A release names artifacts, and a site pointing at one serves them — so the
     * question *may this site use this release* has to have an answer, and it starts here.
     */
    tenantId: z.string().min(1),

    kernel: PinnedArtifactSchema,

    /**
     * Part id → the exact artifact.
     *
     * A record rather than an array, because a release must not name one part twice — an array would
     * make that representable and the second entry would win by accident of ordering.
     */
    parts: z.record(z.string(), PinnedArtifactSchema),

    /**
     * What every part in this release calls, by contract key.
     *
     * The union of the parts' requirements, computed at compose time. A *requirement*, never a
     * grant: a site says what it exposes and at what gate, and composing checks one list against the
     * other. A part must never choose its own gate — if it could, installing one would be a
     * privilege escalation with nobody in the loop.
     */
    requires: z.array(z.string()).default([]),

    /**
     * Enforced by the cdn rather than baked into a build, so changing one rebuilds nothing.
     *
     * Part of the hash, because it changes what the page does — two releases differing only in
     * policy are genuinely different releases.
     */
    policy: z.record(z.string(), z.string()).default({}),

    // `exposure` was removed from ReleaseSchema (D4).
    //
    // A release is site-independent by design (C1): two organizations composing the same kernel
    // and parts have composed the same thing. Exposure and gates are per-site (D2): one site may
    // expose a contract as public while another requires user on the same release.
    //
    // An exposure hash computed over gates cannot live on the release — two sites sharing one
    // release at different gates would need one field to hold two values. Furthermore, compose
    // runs without a site, so a compose-time gate check is impossible.
    //
    // Instead, two distinct hashes exist:
    // - The Gate Hash: per site, on RouteTable.exposure (and x-exposure header).
    // - The Shape Hash: site-independent, on client descriptors and RouteTable.shapeHash,
    //   answering whether the generated client's contract schemas are stale.
    //
    // On the release, contract requirements are tracked cleanly by `requires` (checked against
    // site grants at deploy time).

    /**
     * ## Rolling: a release that re-composes itself when a part it names is released
     *
     * The flag an operator sets to say *this one follows the code*. When `builder.part_released`
     * fires for a part inside `source`, the ranges below are resolved again; if that produces a
     * different composition, the new release inherits the flag, this one is marked superseded, and
     * every site sitting on it is moved across.
     *
     * **It is on the release rather than on the site**, and that took a wrong turn to see. A site
     * is a hostname and a record; "follows latest" is a property of the *composition* it points at,
     * and putting it on the site would mean two sites sharing one release could disagree about
     * whether that release was following anything — one field holding two values, which is exactly
     * the mistake `exposure` made before it was taken off this schema (D4).
     *
     * A release still never mutates: rolling produces a **new** release and moves the pointer.
     * Rollback is unaffected and stays one write backwards, to a release that is still there.
     */
    rolling: z.boolean().default(false),

    /**
     * The requirements this was composed from — **ranges, not the exacts above.**
     *
     * A release records what it resolved *to* and, until now, nothing recorded what it resolved
     * *from*. That made rolling impossible to express: re-resolving `^0.15` needs `^0.15`, and all
     * that survived was `0.15.10`. Reconstructing a range from a pinned version is guesswork about
     * what somebody meant, and guessing here changes what runs on a hostname.
     *
     * Not part of `hash`, deliberately. Two people composing the same set have composed the same
     * release whether one of them wrote `^0.2` and the other `0.2.4` — identity is the artifacts,
     * and the ranges are how this one got there.
     *
     * Optional because releases composed before this existed have none. Those cannot roll, and are
     * skipped by name rather than rolled from a guess.
     */
    source: z.object({
        kernel: z.string().min(1),
        // The compose input as it was given, `kind` included — so re-composing is handing the same
        // argument back rather than reconstructing one and hoping it means the same thing.
        parts: z.array(z.object({
            kind: z.enum(['application', 'extension']),
            id: z.string().min(1),
            version: z.string().min(1),
        })),
    }).optional(),

    /**
     * The release that replaced this one when it rolled.
     *
     * A chain rather than a flag, so *what happened to the thing I deployed on Tuesday* is
     * answerable by following it, and a rolled-past release is still a real release somebody can
     * deploy again.
     */
    supersededBy: z.string().min(1).optional(),

    composedAt: z.date(),
});
