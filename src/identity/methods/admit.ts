import { MeshError, type IServiceContext } from '@flybyme/mesh';
import { z } from 'zod';

/**
 * The contract asked before someone joins an organization, when the application running mesh-serve
 * limits how many people one may have (a plan's seats). Unset: no limit. It is called as the
 * organization, with `{ resource: 'members', current, adding: 1 }`, and answers `{ allowed, why? }`.
 * Read at each call: IDENTITY_ADMIT_CONTRACT.
 */
const admitContract = (): string | undefined => process.env.IDENTITY_ADMIT_CONTRACT;

const VerdictSchema = z.object({
    allowed: z.boolean(),
    why: z.string().optional(),
});

/**
 * One more person in the organization, or a refusal (402 PLAN_LIMIT) saying why. Counts everyone in
 * it now, the owner included. An answer that isn't a verdict refuses too: a limit that can't be read
 * is not a yes.
 */
export async function admitMember(ctx: IServiceContext, organization: { id: string; name: string }): Promise<void> {
    const contract = admitContract();
    if (contract === undefined || contract === '') return;

    const scope = { user: { id: ctx.meta?.user?.id ?? '', tenant_id: organization.id, organizationId: organization.id } };
    const current = await ctx.db('identity.membership', scope).count({});

    const answer = await ctx.callNamed(contract, { resource: 'members', current, adding: 1 }, {
        meta: { tenant_id: organization.id, user: { id: ctx.meta?.user?.id ?? '', tenant_id: organization.id, tenantId: organization.id } },
    });
    const verdict = VerdictSchema.safeParse(answer);

    if (!verdict.success) {
        throw new MeshError({ message: `Could not check how many people ${organization.name} may have; try again shortly.`, code: 'UNAVAILABLE', status: 503 });
    }

    if (!verdict.data.allowed) {
        throw new MeshError({ message: verdict.data.why ?? `${organization.name} has as many people as it may have.`, code: 'PLAN_LIMIT', status: 402 });
    }
}
