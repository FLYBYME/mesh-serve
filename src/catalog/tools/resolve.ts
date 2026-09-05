/**
 * `catalog.resolve` — ranges in, exact versions out.
 *
 * It resolves; it does not deploy. What a site *runs* is a release, written separately, so a version
 * appearing here changes nothing until somebody composes with it. That is the difference between a
 * registry and a deploy, and it is why a site names a range rather than following a branch.
 *
 * All the interesting logic is in `methods/semver.ts` and is pure. This is the part that talks to a
 * database, and it is deliberately dull.
 */

import { ClientError, z, type IServiceContext } from '@flybyme/mesh';

import type { CatalogService } from '../catalog.service.js';
import { resolveContract } from '../contracts/part.contract.js';
import { boundsOf, highest } from '../methods/semver.js';

type Input = z.infer<typeof resolveContract['inputSchema']>;
type Output = z.infer<typeof resolveContract['outputSchema']>;

export async function catalog_resolve(
    this: CatalogService,
    input: Input,
    ctx: IServiceContext,
): Promise<Output> {
    const unsatisfied: Output['unsatisfied'] = [];

    const pick = async (
        name: string,
        range: string,
    ): Promise<{ name: string; version: string; commit: string } | undefined> => {
        // An unsupported range is reported as *that*, not as "nothing published". A range nobody
        // implemented matches nothing, and looks exactly like a part that does not exist.
        if (boundsOf(range) === undefined) {
            unsatisfied.push({ name, wanted: range, reason: `"${range}" is not a range this understands` });
            return undefined;
        }

        const published = await ctx.call('partVersion.find', {
            query: { partName: name },
            // Bounded on purpose. Resolution over a few hundred versions is already pathological, and
            // an unbounded find here would make a page load read an entire collection.
            limit: 500,
        });

        if (published.length === 0) {
            unsatisfied.push({ name, wanted: range, reason: 'no versions published' });
            return undefined;
        }

        const chosen = highest(published.map((row) => row.version), range);
        if (chosen === undefined) {
            // The published versions are named, because "nothing matches ^2.0" is far less useful
            // than "nothing matches ^2.0; 1.4.2 and 1.3.0 exist".
            const known = published.map((row) => row.version).slice(0, 5).join(', ');
            unsatisfied.push({ name, wanted: range, reason: `no version satisfies it; published: ${known}` });
            return undefined;
        }

        const row = published.find((r) => r.version === chosen)!;
        return { name, version: row.version, commit: row.commit };
    };

    const kernels = await ctx.call('part.find', { query: { kind: 'kernel' }, limit: 50 });
    if (kernels.length === 0) {
        throw new ClientError('No kernel is published, so nothing can be resolved.', 'no_kernel', 409);
    }
    if (kernels.length > 1) {
        // One kernel, for now, and said out loud rather than picking one. The day there are two, a
        // site has to name which — and silently choosing would be a page running a framework nobody
        // selected.
        throw new ClientError(
            `${String(kernels.length)} kernels are published and a site does not say which. ` +
            `Naming the kernel is not implemented.`,
            'kernel_ambiguous', 409,
        );
    }

    const kernelName = kernels[0]!.name;
    const kernel = await pick(kernelName, input.kernel);

    const parts: Output['parts'] = [];
    for (const wanted of input.parts) {
        const found = await pick(wanted.name, wanted.version);
        if (found !== undefined) parts.push(found);
    }

    return {
        // A failed kernel resolution is reported in `unsatisfied` like anything else; the caller
        // checks that array rather than this placeholder.
        kernel: kernel ?? { name: kernelName, version: '', commit: '' },
        parts,
        unsatisfied,
    };
}
