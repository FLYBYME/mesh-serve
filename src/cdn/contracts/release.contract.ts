/**
 * What the cdn owns alongside sites: releases — a kernel and a set of parts known to work together.
 *
 * **A release is immutable and shared.** Its hash is derived from its contents, so composing the
 * same set twice yields the same release rather than a second row describing it. That is what makes
 * *"staging runs the same code as production"* a fact rather than a claim: both point at one hash.
 *
 * ## What is exposed
 *
 * `release.find` is never exposed. It would enumerate every composition on the platform — which
 * parts each tenant runs, at which versions — and an unbounded find has no notion of the caller's
 * scope, so authorization could refuse the caller but never narrow the result.
 */

import { defineContract, defineCrud, defineEvent, z } from '@flybyme/mesh';

import { PartRefSchema } from '../schema/site.js';
import { ReleaseSchema } from '../schema/release.js';

export const releaseCrud = defineCrud('release', ReleaseSchema, {
    pluralPath: 'releases',
    // Reading and writing a release record touches no other domain. *Composing* one does — it
    // resolves ranges against the catalog and checks requirements — and that is `compose`'s job,
    // not a hooked create.
    dependencies: [],
});

/** A release, as stored. */
export type Release = z.infer<typeof releaseCrud.outputSchema>;

/**
 * Compose a release from version requirements.
 *
 * Ranges in, a release out. It resolves against the catalog, checks that the parts hold together,
 * and writes the row — **or finds that the same composition already exists and returns it**, because
 * the hash is derived from the contents and composing the same set twice is the same release.
 *
 * ## It does not deploy
 *
 * A release exists without any hostname serving it. Deploying is a separate write — `site.releaseHash`
 * — and that separation is the whole point: it is what lets a release be composed, inspected and
 * tested before anything points at it, and what makes rollback one field rather than a re-resolution.
 */
export const composeContract = defineContract({
    domain: 'cdn',
    action: 'compose',
    description: 'Resolve version requirements into a release, and record what holds together.',
    inputSchema: z.object({
        kernel: z.string().min(1).describe('A range, e.g. ^0.3'),
        parts: z.array(PartRefSchema),
        policy: z.record(z.string(), z.string()).optional(),
        name: z.string().optional().describe('A label for people. Never an identity.'),
        /** Resolve and report without writing. What a deploy runs before it decides to. */
        dryRun: z.boolean().optional(),
    }),
    outputSchema: z.object({
        hash: z.string(),
        kernel: z.object({ version: z.string(), digest: z.string() }),
        parts: z.record(z.string(), z.object({ version: z.string(), digest: z.string() })),
        /** True when this exact composition already existed and nothing was written. */
        existed: z.boolean(),
        /**
         * Everything wrong with it, at once.
         *
         * Reported rather than thrown one at a time: somebody composing five parts wants five
         * answers, and failing on the first turns one round trip into five. A fatal problem means
         * nothing was written.
         */
        problems: z.array(z.object({ kind: z.string(), message: z.string() })),
    }),
    rest: { method: 'POST', path: '/releases' },
    destructive: true,
    print: (o) => (o.problems.length === 0
        ? `${o.hash}${o.existed ? ' (existed)' : ''}`
        : `${String(o.problems.length)} problem(s)`),
});

export const ReleaseComposedSchema = z.object({
    hash: z.string(),
    kernel: z.string(),
    partCount: z.number(),
});

/**
 * A release exists.
 *
 * **Nothing deploys on this.** A new release going live on its own would change what every site
 * serves without anyone asking — which is the difference between composing and deploying, and the
 * reason they are two writes.
 */
export const releaseComposedEvent = defineEvent('cdn.release_composed', ReleaseComposedSchema);
