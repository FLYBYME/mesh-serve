import { MeshError, ServiceModule } from '@flybyme/mesh';
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

import { register } from './tools/register.js';
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

export class IdentityService extends ServiceModule {
    public readonly domain = 'identity';

    constructor() {
        super();

        this.mountCrud(userCrud);
        this.mountCrud(organizationCrud);
        this.mountCrud(membershipCrud);
        this.mountCrud(roleCrud);
        this.mountCrud(ticketCrud);
        this.mountCrud(apiTokenCrud);

        this.mountTool(userRegisterContract, register);
        this.mountTool(userSetPasswordContract, setPassword);
        this.mountTool(userGrantRoleContract, grantRole);
        this.mountTool(roleUpsertContract, upsertRole);
        this.mountTool(ticketIssueContract, issueTicket);
        this.mountTool(ticketValidateContract, validateTicket);
        this.mountTool(ticketRevokeContract, revokeTicket);
        this.mountTool(ticketSignOutContract, signOut);
        this.mountTool(apiTokenIssueContract, issueApiToken);
        this.mountTool(apiTokenValidateContract, validateApiToken);
        this.mountTool(whoamiContract, whoami);
        this.mountTool(permitsContract, permits);
        this.mountTool(hasRoleContract, hasRole);
        this.mountTool(ticketResolveContract, resolveTicket);

        this.mountCrudHook('identity.organization', 'create', {
            before: async (input, ctx) => {
                const { ownerId } = input as { ownerId: string };
                const owner = await ctx.db('identity.user').resolve({ id: ownerId });
                if (owner === undefined) {
                    throw new MeshError({ message: `No account "${ownerId}".`, code: 'NOT_FOUND', status: 404 });
                }
                return input;
            },
        });

        this.mountCrudHook('identity.membership', 'create', {
            before: async (input, ctx) => {
                const { organizationId } = input as { organizationId: string };
                const org = await ctx.db('identity.organization').resolve({ id: organizationId });
                if (org === undefined) {
                    throw new MeshError({ message: `No organization "${organizationId}".`, code: 'NOT_FOUND', status: 404 });
                }
                return input;
            },
        });

    }

    /**
     * Roles only -- no account, no "platform" organization, nothing a person could call an
     * identity. Those used to be auto-created here too, with a randomly generated password printed
     * once to the log and never recoverable if missed: a placeholder nobody actually chose. That
     * whole sequence (account, operator role grant, "platform" org, owner membership, the bootstrap
     * api, its exposed contracts) now happens exactly once, deliberately, via `src/bootstrap.ts` --
     * a real person typing their own name/email/password, not the system inventing one for them.
     * Roles stay here because they're safe to seed unconditionally at every boot: a role is a
     * permission template, not an identity, and nothing downstream (bootstrap.ts included) can
     * proceed without `operator`/`owner` already existing.
     */
    public async onStart(broker: IServiceBroker): Promise<void> {
        await ensureBuiltinRoles(broker);
    }
}

// Required to be loadable as a dynamically-loaded part (the same mechanism serve.part.start
// already uses, and the precompiled core-parts loader `start`/`bootstrap` will use) -- both
// dynamically `import()`/`require()` this module and construct its default export directly,
// same convention `startService.ts` already documents ("the default export exists because it's
// constructed").
export default IdentityService;
