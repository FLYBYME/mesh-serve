/**
 * `catalog.declare` — a part, and how it builds, without publishing one.
 *
 * This is where a part now begins. `catalog.publish` still creates one as a side effect of
 * publishing a version, because a CI job publishing straight from a repository should not have to
 * make two calls — but that ordering is what made a repository the only place a part could be
 * described, and describing one is not the same act as shipping code.
 *
 * ```
 * declare  →  the part exists, and the platform knows how to build it
 * release  →  pull, mint a version, publish it, build it        (builder.release_part)
 * ```
 *
 * Everything a person can do from the console goes through the first line. Nothing here clones
 * anything or runs anything: it writes a row.
 */

import { ClientError, z, type IServiceContext } from '@flybyme/mesh';

import type { CatalogService } from '../catalog.service.js';
import { declareContract } from '../contracts/part.contract.js';

type Input = z.infer<typeof declareContract['inputSchema']>;
type Output = z.infer<typeof declareContract['outputSchema']>;

export async function catalog_declare(
    this: CatalogService,
    input: Input,
    ctx: IServiceContext,
): Promise<Output> {
    const caller = ctx.meta?.user?.tenant_id ?? ctx.meta?.tenant_id;
    if (caller === undefined || caller === '') {
        throw new ClientError(
            'Declaring a part records which repository a builder will clone with whatever ' +
            'credential it holds, so it requires an authenticated caller. This call carries none.',
            'caller_unknown', 401,
        );
    }

    /**
     * A kernel declares no kernel, and everything else must.
     *
     * Refused here rather than at compose time, where the failure is a part quietly excluded from a
     * release with a `kernel_mismatch` nobody asked for. This is the one moment somebody is looking
     * at the thing they just typed.
     */
    if (input.kind === 'kernel' && input.declaration.kernel !== undefined) {
        throw new ClientError(
            'A kernel has no kernel range: it is the thing other parts declare a range against.',
            'kernel_declares_kernel', 400,
        );
    }

    const found = await ctx.call('part.find_one', { query: { name: input.name } });

    if (found === null || found === undefined) {
        const created = await ctx.call('part.create', {
            name: input.name,
            kind: input.kind,
            repository: input.repository,
            publisher: caller,
            declaration: input.declaration,
            description: input.description ?? '',
            ...(input.homepage === undefined ? {} : { homepage: input.homepage }),
            ...(input.license === undefined ? {} : { license: input.license }),
            ...(input.keywords === undefined ? {} : { keywords: input.keywords }),
            ...(input.icon === undefined ? {} : { icon: input.icon }),
        });

        ctx.logger.info(`[catalog] declared ${input.kind} ${input.name} from ${input.repository}`);
        return { partId: created.id, name: input.name, existed: false };
    }

    // The same two refusals `catalog.publish` makes, for the same reasons: a changed `kind` is a
    // different part, and whoever can write this row changes what runs on somebody's hostname.
    if (found.kind !== input.kind) {
        throw new ClientError(
            `"${input.name}" is declared as a ${found.kind} and this says ${input.kind}. ` +
            `A part's kind is its identity; declare it under a different name.`,
            'part_kind_changed', 409,
        );
    }

    if (found.publisher !== caller) {
        // Not found, not forbidden: which organization publishes a part is not something an
        // unrelated caller gets to confirm by probing.
        throw new ClientError('No such part.', 'part_not_found', 404);
    }

    /**
     * Presentation is followed; the declaration is replaced.
     *
     * Two different rules, deliberately. A field the caller omits from *presentation* is left alone,
     * so a console that does not know about `icon` cannot erase one. The declaration is a single
     * object and arrives whole — a half-declaration would build something nobody described.
     */
    const changes: Record<string, unknown> = { declaration: input.declaration };
    const follow = <T>(current: T, next: T | undefined, key: string): void => {
        if (next !== undefined && JSON.stringify(current) !== JSON.stringify(next)) {
            changes[key] = next;
        }
    };

    if (found.repository !== input.repository) changes['repository'] = input.repository;
    follow(found.description, input.description, 'description');
    follow(found.homepage, input.homepage, 'homepage');
    follow(found.license, input.license, 'license');
    follow(found.keywords, input.keywords, 'keywords');
    follow(found.icon, input.icon, 'icon');

    await ctx.call('part.update', { id: found.id, ...changes });

    return { partId: found.id, name: input.name, existed: true };
}
