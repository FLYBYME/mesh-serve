/**
 * Rolling releases: what happens when a part a release names is released again.
 *
 * ```
 * builder.part_released  →  every rolling release naming that part
 *                        →  compose from the ranges it kept
 *                        →  a different hash?  →  new release, sites moved across
 * ```
 *
 * **A release still never mutates.** Rolling composes a *new* one and moves the pointer, so the
 * release somebody deployed on Tuesday is still there, still serving the digests it always did, and
 * rollback is still one write backwards. What rolls is which release a hostname points at.
 *
 * ## Why this is not a rebuild
 *
 * Nothing here builds anything. The artifacts already exist — `builder.release_part` produced them
 * before firing the event — so a roll is: resolve some ranges, hash the result, write a row, update
 * a field. That is the property the whole artifact model was for: a release is a set of pointers,
 * so recomposing one is cheap enough to do automatically.
 */

import type { IServiceContext } from '@flybyme/mesh';

import type { Release } from '../contracts/release.contract.js';

/**
 * What `builder.part_released` carries, stated here rather than imported from the builder's
 * contract file.
 *
 * The import was the obvious thing and it was wrong in a way worth recording: that file augments
 * `@flybyme/mesh` (`interface ToolContract { requirements?: … }`), and pulling it into the cdn's
 * graph pulled the augmentation with it — which broke type inference on `broker.call` in every file
 * that transitively imports this one, reported as a dozen errors in `bring-up.ts` that had nothing
 * to do with any of them.
 *
 * A structural type is also the more honest coupling. The cdn does not depend on the builder; it
 * depends on the *shape of an event*, which is what an event contract is for.
 */
export interface PartReleased {
    readonly tenantId: string;
    readonly part: string;
    readonly kind: 'kernel' | 'application' | 'extension';
    readonly version: string;
    readonly commit: string;
    readonly digest?: string;
}

/**
 * Does this release follow the part that was just released?
 *
 * A kernel always applies: a release names exactly one, by range, and the catalog refuses to resolve
 * when more than one kernel is published — so there is no ambiguity to resolve here. Everything else
 * has to be named in the ranges the release kept.
 */
export function follows(release: Release, released: Pick<PartReleased, 'part' | 'kind'>): boolean {
    if (release.source === undefined) return false;
    if (released.kind === 'kernel') return true;
    return release.source.parts.some((part) => part.id === released.part);
}

/**
 * Roll every release that follows this part.
 *
 * Failures are per release and logged, never thrown: this runs from an event handler, where a throw
 * reaches nobody who can act on it, and one release that cannot compose must not stop the others
 * from rolling.
 */
export async function rollForPart(ctx: IServiceContext, released: PartReleased): Promise<void> {
    const rolling = await ctx.call('release.find', { query: { rolling: true }, limit: 200 });

    for (const release of rolling) {
        /**
         * A release only follows its own tenant's parts.
         *
         * The event is `scopedBy: 'tenantId'` so this should already hold, and it is checked anyway:
         * the consequence of getting it wrong is one organization's code being deployed onto
         * another's hostname, which is not a failure to discover from a log afterwards.
         */
        if (release.tenantId !== released.tenantId) continue;
        if (!follows(release, released)) continue;

        try {
            await rollOne(ctx, release, released);
        } catch (error) {
            ctx.logger.warn(
                `[cdn] ${release.hash} did not roll for ${released.part}@${released.version}: ` +
                `${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}

async function rollOne(
    ctx: IServiceContext,
    release: Release,
    released: PartReleased,
): Promise<void> {
    const source = release.source;
    if (source === undefined) return;

    /**
     * Composed **as the release's own tenant**, not as whoever is on this connection.
     *
     * There is no caller here — an event handler runs on a node, on nobody's behalf — and
     * `cdn.compose` records who owns a release, so it needs one. The honest answer is the tenant
     * that owns the release being rolled, which is also the only tenant whose parts could have
     * triggered this: the event is scoped, and the check above enforces it a second time.
     */
    const meta = { tenant_id: release.tenantId, user: { id: 'rolling', tenant_id: release.tenantId } };

    const composed = await ctx.call('cdn.compose', {
        kernel: source.kernel,
        parts: [...source.parts],
        policy: release.policy,
        name: release.name,
        rolling: true,
    }, { meta });

    // A composition that does not hold together is reported, never deployed. Every problem at once,
    // because the operator who set `rolling` is the one who has to fix it.
    if (composed.hash === '') {
        ctx.logger.warn(
            `[cdn] ${release.hash} follows ${released.part} but no longer composes: ` +
            composed.problems.map((problem) => problem.message).join('; '),
        );
        return;
    }

    if (composed.hash === release.hash) {
        // Nothing moved. The ordinary case for a part rebuilt to identical bytes, and the reason
        // the trigger can afford to be a release rather than a new digest.
        return;
    }

    /**
     * The flag moves with the pointer.
     *
     * Exactly one release in a chain is `rolling`, so the next release of any part finds one row to
     * act on rather than a growing set of superseded ones that all still claim to be following.
     */
    await ctx.call('release.update', {
        id: release.id, rolling: false, supersededBy: composed.hash,
    });

    const next = await ctx.call('release.find_one', { query: { hash: composed.hash } });
    if (next !== null && next !== undefined && !next.rolling) {
        // `compose` was told `rolling: true`, but the composition may have already existed from
        // before — an earlier manual compose, or a roll that was interrupted after the write.
        await ctx.call('release.update', { id: next.id, rolling: true });
    }

    const sites = await ctx.call('site.find', {
        query: { releaseHash: release.hash }, limit: 200,
    });

    for (const site of sites) {
        try {
            await ctx.call('cdn.deploy', { host: site.host, release: composed.hash }, { meta });
        } catch (error) {
            /**
             * One site failing does not stop the others, and the usual reason is worth reading:
             * `cdn.deploy` refuses a release calling a contract the site does not expose. A rolled
             * release can acquire one — a new version of a part may call something the old one did
             * not — and that refusal is the grant check doing its job at exactly the right moment.
             */
            ctx.logger.warn(
                `[cdn] ${site.host} stayed on ${release.hash}: ` +
                `${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    ctx.logger.info(
        `[cdn] rolled ${release.hash} → ${composed.hash} for ${released.part}@${released.version} ` +
        `(${String(sites.length)} site(s))`,
    );

    ctx.emit('cdn.release_rolled', {
        tenantId: release.tenantId,
        from: release.hash,
        to: composed.hash,
        part: released.part,
        version: released.version,
        hosts: sites.map((site) => site.host),
    });
}
