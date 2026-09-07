/**
 * `cdn.compose` — version requirements in, a release out.
 *
 * Resolve against the catalog, check that the parts hold together, write the row. Or find that the
 * same composition already exists and return it, because the hash is derived from the contents and
 * composing the same set twice **is** the same release.
 *
 * It does not deploy. A release exists without any hostname serving it, and that separation is the
 * point: it is what lets a release be composed, inspected and tested before anything points at it,
 * and what makes rollback one field rather than a re-resolution.
 */

import { ClientError, z, type IServiceContext } from '@flybyme/mesh';

import type { CdnService } from '../cdn.service.js';
import { composeContract } from '../contracts/release.contract.js';
import {
    checkComposition, isFatal, releaseHash,
    type CompositionProblem, type Requirement,
} from '../methods/release.js';
import type { PinnedArtifact } from '../schema/release.js';

type Input = z.infer<typeof composeContract['inputSchema']>;
type Output = z.infer<typeof composeContract['outputSchema']>;

export async function cdn_compose(
    this: CdnService,
    input: Input,
    ctx: IServiceContext,
): Promise<Output> {
    const tenantId = callerOf(ctx);

    // Ranges in, exact versions out. A pure function over the catalog, called rather than
    // reimplemented — resolution living in two places is resolution that will disagree.
    const resolved = await ctx.call('catalog.resolve', {
        kernel: input.kernel,
        parts: input.parts.map((part) => ({ name: part.id, version: part.version })),
    });

    const problems: CompositionProblem[] = resolved.unsatisfied.map((miss) => ({
        kind: 'missing_part' as const,
        message: `Nothing satisfies ${miss.name} ${miss.wanted}: ${miss.reason}`,
    }));

    // Every resolved part's own requirements, which is where a transitive need is found: an
    // Application consuming AUTH declared `requiredParts: [auth]`, and a release without it is a
    // blank panel and a console error rather than a refused deploy.
    const pinned: Record<string, PinnedArtifact> = {};
    const required: Requirement[] = [];
    const requires = new Set<string>();
    const kernelRanges: Record<string, string | undefined> = {};

    for (const part of resolved.parts) {
        const version = await ctx.call('partVersion.find_one', {
            query: { partName: part.name, version: part.version },
        });
        if (version === null || version === undefined) continue;

        if (version.artifactDigest === undefined) {
            // Published and never built. A real state — `catalog.publish` writes `declared` — and
            // the fix is to build it, so it is named rather than silently dropped.
            problems.push({
                kind: 'missing_part',
                message: `${part.name}@${part.version} is published but has no artifact. Build it first.`,
            });
            continue;
        }

        pinned[part.name] = { version: part.version, digest: version.artifactDigest };
        kernelRanges[part.name] = version.kernel;
        for (const key of version.requires) requires.add(key);
        for (const need of version.requiredParts) {
            required.push({ by: part.name, id: need.id, version: need.version, optional: need.optional });
        }
    }

    const kernelVersion = await ctx.call('partVersion.find_one', {
        query: { partName: resolved.kernel.name, version: resolved.kernel.version },
    });
    const kernelDigest = kernelVersion?.artifactDigest;

    if (kernelDigest === undefined) {
        problems.push({
            kind: 'missing_part',
            message: `The kernel ${resolved.kernel.name}@${resolved.kernel.version} has no artifact. Build it first.`,
        });
    }

    // **Part and kernel requirements only.** A release cannot check contracts: what is exposed and at what gate
    // is the *site's* record, and a release is deliberately site-independent — that is the whole
    // reason a hundred hostnames can share one. So the grant check happens at deploy, where both
    // halves are known, and `requires` is carried on the release for it to check against.
    problems.push(...checkComposition(
        Object.keys(pinned),
        required,
        [],
        [],
        { version: resolved.kernel.version, ranges: kernelRanges },
    ));

    if (problems.some(isFatal) || kernelDigest === undefined) {
        // Nothing is written. Every problem is reported at once, because somebody composing five
        // parts wants five answers and failing on the first turns one round trip into five.
        return {
            hash: '', kernel: { version: '', digest: '' }, parts: {}, existed: false,
            problems: problems.map((p) => ({ kind: p.kind, message: p.message })),
        };
    }

    const kernel: PinnedArtifact = { version: resolved.kernel.version, digest: kernelDigest };
    const policy = input.policy ?? {};
    const hash = releaseHash({ kernel, parts: pinned, policy });

    const existing = await ctx.call('release.find_one', { query: { hash } });
    if (existing !== null && existing !== undefined) {
        // The same composition is the same release. Returning it rather than writing a second row is
        // what makes "staging runs what production runs" answerable by comparing one field.
        return {
            hash, kernel, parts: pinned, existed: true,
            problems: problems.map((p) => ({ kind: p.kind, message: p.message })),
        };
    }

    if (input.dryRun !== true) {
        await ctx.call('release.create', {
            hash,
            name: input.name ?? '',
            tenantId,
            kernel,
            parts: pinned,
            requires: [...requires].sort(),
            policy,
            composedAt: new Date(),
        });

        ctx.emit('cdn.release_composed', {
            // The same `tenantId` written on the row above, so the event and the record cannot
            // disagree about who this release belongs to.
            tenantId,
            hash, kernel: kernel.version, partCount: Object.keys(pinned).length,
        });
    }

    return {
        hash, kernel, parts: pinned, existed: false,
        problems: problems.map((p) => ({ kind: p.kind, message: p.message })),
    };
}

/**
 * Who is composing.
 *
 * A release names artifacts and a site pointing at one serves them, so *may this site use this
 * release* has to have an answer and it starts here. Refused rather than defaulted: an
 * unauthenticated compose is one somebody arranged to be unauthenticated.
 */
function callerOf(ctx: IServiceContext): string {
    const meta = ctx.meta as { user?: { tenant_id?: string }; tenant_id?: string } | undefined;
    const caller = meta?.user?.tenant_id ?? meta?.tenant_id;

    if (caller === undefined) {
        throw new ClientError(
            'Composing a release records who owns it, so it requires a caller. This call carries none.',
            'caller_unknown', 401,
        );
    }
    return caller;
}
