import { MeshError, ServiceModule } from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';
import { randomBytes } from 'node:crypto';

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

import { hashPassword } from './methods/hash.js';

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
                const owner = await ctx.call('identity.user.resolve', { id: ownerId });
                if (owner === undefined) {
                    throw new MeshError({ message: `No account "${ownerId}".`, code: 'NOT_FOUND', status: 404 });
                }
                return input;
            },
        });

        this.mountCrudHook('identity.membership', 'create', {
            before: async (input, ctx) => {
                const { organizationId } = input as { organizationId: string };
                const org = await ctx.call('identity.organization.resolve', { id: organizationId });
                if (org === undefined) {
                    throw new MeshError({ message: `No organization "${organizationId}".`, code: 'NOT_FOUND', status: 404 });
                }
                return input;
            },
        });

    }

    public async onStart(broker: IServiceBroker): Promise<void> {
        // Checked every boot, independent of whether the role already existed: an install that had
        // the role from before permissions lived on it would otherwise never get these. identity.permits
        // has no superuser bypass and no pattern means "everything" (matchesContract only does an
        // exact key or a "<prefix>.*" wildcard), so operator is powerless without these explicitly.
        const operatorPermissions = ['identity.*', 'serve.*'];
        const roles = await broker.call('identity.role.find', { query: {} });
        const existingOperator = roles.find((r) => r.key === 'operator');

        if (existingOperator === undefined) {
            broker.logger.info('No operator role found, creating one...');
            await broker.call('identity.role.create', {
                key: 'operator', name: 'Operator', scope: 'global', builtin: true, inherits: [],
                permissions: operatorPermissions,
            });
        } else {
            const missing = operatorPermissions.filter((p) => !existingOperator.permissions.includes(p));
            if (missing.length > 0) {
                broker.logger.info(`Granting operator ${missing.join(', ')}...`);
                await broker.call('identity.role.update', {
                    id: existingOperator.id,
                    permissions: [...existingOperator.permissions, ...missing],
                });
            }
        }

        const userCount = await broker.call('identity.user.count', { query: {} });
        if (userCount > 0) {
            broker.logger.debug('User count > 0, skipping operator creation.');
            return;
        }

        const password = randomBytes(24).toString('base64url');
        const passwordHash = await hashPassword(password);
        await broker.call('identity.user.create', {
            email: 'operator@node.invalid',
            displayName: 'operator',
            passwordHash,
            roles: ['operator'],
            provisional: true,
        });

        broker.logger.info('\nFIRST BOOT -- no accounts existed, so one was created.\n\n'
            + '  email     operator@node.invalid\n'
            + `  password  ${password}\n\n`
            + 'This is shown once and is not recoverable. It can do nothing except set its own\n'
            + 'password -- every other call is refused until it does.\n\n',
        );
    }
}
