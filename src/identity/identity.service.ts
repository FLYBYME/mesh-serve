import { MeshError } from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';

import { userCrud, userRegisterContract, userSetPasswordContract, userGrantRoleContract } from './contracts/user.contract.js';
import { organizationCrud } from './contracts/organization.contract.js';
import { membershipCrud } from './contracts/membership.contract.js';
import { roleCrud, roleUpsertContract } from './contracts/role.contract.js';
import {
    ticketCrud,
    ticketIssueContract,
    ticketValidateContract,
    ticketRevokeContract,
    ticketSignOutContract,
    ticketResolveContract,
} from './contracts/ticket.contract.js';
import { apiTokenCrud, apiTokenIssueContract, apiTokenValidateContract } from './contracts/apiToken.contract.js';
import { whoamiContract, permitsContract, hasRoleContract } from './contracts/identity.contract.js';

import { register as registerUser } from './tools/register.js';
import { setPassword } from './tools/setPassword.js';
import { grantRole } from './tools/grantRole.js';
import { upsertRole } from './tools/upsertRole.js';
import { issueTicket } from './tools/issueTicket.js';
import { validateTicket } from './tools/validateTicket.js';
import { revokeTicket } from './tools/revokeTicket.js';
import { signOut } from './tools/signOut.js';
import { issueApiToken } from './tools/issueApiToken.js';
import { validateApiToken } from './tools/validateApiToken.js';
import { whoami } from './tools/whoami.js';
import { permits } from './tools/permits.js';
import { hasRole } from './tools/hasRole.js';
import { resolveTicket } from './tools/resolveTicket.js';

import { ensureBuiltinRoles } from './builtinRoles.js';

export const IDENTITY_DOMAIN = 'identity';

/**
 * Migrated off `ServiceModule` -- no class, no `mountCrud`/`mountTool`/`mountCrudHook`. The audit in
 * docs/CONTRACT_DRIVEN_PLACEMENT.md found identity holds zero instance state, so the class was only
 * ever where the code lived.
 *
 * `register` is the standalone part shape (`catalog/methods/loadModule.ts`), and it is also where
 * the old `onStart` goes: it runs at load with the broker already live, which is exactly when the
 * builtin roles should be seeded. No `stop` is returned because there is nothing with a lifetime
 * here to tear down.
 *
 * Roles only -- no account, no "platform" organization, nothing a person could call an identity.
 * Those used to be auto-created here too, with a randomly generated password printed once to the
 * log and never recoverable if missed: a placeholder nobody actually chose. That whole sequence
 * (account, operator role grant, "platform" org, owner membership, the bootstrap api, its exposed
 * contracts) now happens exactly once, deliberately, via `bootstrap` -- a real person typing their
 * own name/email/password, not the system inventing one for them. Roles stay here because they're
 * safe to seed unconditionally at every boot: a role is a permission template, not an identity, and
 * nothing downstream (bootstrap included) can proceed without `operator`/`owner` already existing.
 */
export async function register(broker: IServiceBroker): Promise<string> {
    broker.registerCrud(userCrud);
    broker.registerCrud(organizationCrud, {
        hooks: {
            create: {
                before: async (input, ctx) => {
                    const { ownerId } = input as { ownerId: string };
                    const owner = await ctx.db('identity.user').resolve({ id: ownerId });
                    if (owner === undefined) {
                        throw new MeshError({ message: `No account "${ownerId}".`, code: 'NOT_FOUND', status: 404 });
                    }
                    return input;
                },
            },
        },
    });
    broker.registerCrud(membershipCrud, {
        hooks: {
            create: {
                before: async (input, ctx) => {
                    const { organizationId } = input as { organizationId: string };
                    const org = await ctx.db('identity.organization').resolve({ id: organizationId });
                    if (org === undefined) {
                        throw new MeshError({ message: `No organization "${organizationId}".`, code: 'NOT_FOUND', status: 404 });
                    }
                    return input;
                },
            },
        },
    });
    broker.registerCrud(roleCrud);
    broker.registerCrud(ticketCrud);
    broker.registerCrud(apiTokenCrud);

    broker.registerContract(userRegisterContract, registerUser);
    broker.registerContract(userSetPasswordContract, setPassword);
    broker.registerContract(userGrantRoleContract, grantRole);
    broker.registerContract(roleUpsertContract, upsertRole);
    broker.registerContract(ticketIssueContract, issueTicket);
    broker.registerContract(ticketValidateContract, validateTicket);
    broker.registerContract(ticketRevokeContract, revokeTicket);
    broker.registerContract(ticketSignOutContract, signOut);
    broker.registerContract(apiTokenIssueContract, issueApiToken);
    broker.registerContract(apiTokenValidateContract, validateApiToken);
    broker.registerContract(whoamiContract, whoami);
    broker.registerContract(permitsContract, permits);
    broker.registerContract(hasRoleContract, hasRole);
    // Deliberately replaces the `resolve` action defineCrud generates for identity.ticket: this
    // one resolves by *token*, not by id, and has always been what `identity.ticket.resolve`
    // actually means at runtime. Under ServiceModule that override was invisible -- mountTool's map
    // simply let whichever mounted last win. Saying it out loud is the only change.
    broker.registerContract(ticketResolveContract, resolveTicket, { replace: true });

    await ensureBuiltinRoles(broker);

    return IDENTITY_DOMAIN;
}
