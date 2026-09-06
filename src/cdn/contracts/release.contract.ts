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

    // The hash is derived from the contents, so two rows under one hash would be two rows describing
    // one composition — and the whole reason a release is *checkable* is that it cannot happen.
    unique: [{ fields: 'hash', scope: 'global' }],
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

/**
 * Point a hostname at a release. **This is the deploy, and it is one field.**
 *
 * Which is what makes rollback the same write backwards — no rebuild, no re-resolution, nothing to
 * get wrong at the moment somebody is under pressure.
 *
 * It is also the only place the grant check can happen. A release says what its parts *call*; a site
 * says what it *exposes and at what gate*; a release is deliberately site-independent, so neither
 * knows the other until here.
 */
export const deployContract = defineContract({
    domain: 'cdn',
    action: 'deploy',
    description: 'Point a hostname at a release.',
    inputSchema: z.object({
        host: z.string().min(1),
        release: z.string().min(1).describe('→ release.hash'),
    }),
    outputSchema: z.object({
        host: z.string(),
        release: z.string(),
        /** False when the site already served this release and nothing was written. */
        changed: z.boolean(),
        /** Contracts the site exposes that nothing in this release calls. Reported, never fatal. */
        unusedGrants: z.array(z.string()),
    }),
    rest: { method: 'POST', path: '/sites/:host/deploy' },
    destructive: true,
    print: (o) => (o.changed ? `${o.host} → ${o.release}` : `${o.host} already on ${o.release}`),
});

export const ReleaseComposedSchema = z.object({
    /**
     * Who composed it, and **the reason this event can be delivered at all**.
     *
     * It was not here until 2026-09-06. The payload carried what another *service* needed — a hash,
     * a kernel, a count — and nothing else, because no browser had ever subscribed. An event with no
     * scope is delivered to nobody, so this was unsubscribable rather than merely inconvenient.
     */
    tenantId: z.string().min(1),
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
 *
 * `scopedBy: 'tenantId'` because a composition names the exact parts and versions an organization is
 * about to run. That is not secret, and it is not anybody else's business either.
 */
export const releaseComposedEvent = defineEvent('cdn.release_composed', ReleaseComposedSchema, {
    scopedBy: 'tenantId',
});
