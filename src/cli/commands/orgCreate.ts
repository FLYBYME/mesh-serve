import type { Command as CommanderCommand } from 'commander';
import { MeshCallError } from '@flybyme/mesh-web/net';

import { BaseCommand } from '../core/BaseCommand.js';
import { buildClient } from '../client.js';
import { resolveApi } from '../resolveApi.js';
import type { Session } from '../session.js';

interface OrgCreateArgs {
    readonly slug: string;
    readonly name: string;
}

/**
 * `identity.organization.create`, from the terminal -- the step that had to happen by curl before
 * `init --tenant <a-second-organization>` meant anything: an operator can create/build inside any
 * tenant (`resolveEffectiveTenantId`), but nothing made a *second* tenant to point it at. Owned by
 * whoever is currently signed in (`identity.whoami`), since that is who ran the command.
 */
export class OrgCreateCommand extends BaseCommand {
    public readonly name = 'org-create';
    public readonly description = 'org-create <slug> <name>: create an identity.organization, owned by the signed-in account';

    constructor(private readonly session: Session) {
        super();
    }

    public register(program: CommanderCommand): void {
        program
            .command(this.name)
            .description(this.description)
            .argument('<slug>', 'Unique, URL-safe identifier')
            .argument('<name>', 'Display name')
            .action(async (slug: string, name: string) => this.execute({ slug, name }));
    }

    protected async execute({ slug, name }: OrgCreateArgs): Promise<void> {
        if (this.session.credential === undefined) {
            this.logger.error('Not logged in. Run "login" first.');
            return;
        }

        const client = buildClient(this.session);
        try {
            const { apiId } = await resolveApi(client, this.session, {});
            try {
                await client.call('serve.expose.add', { apiId, contract: 'identity.organization.create', role: 'operator' });
            } catch (err) {
                if (!(err instanceof MeshCallError && err.error.kind === 'conflict')) throw err;
            }

            const who = await client.call('identity.whoami');
            const org = await client.call('identity.organization.create', { slug, name, ownerId: who.userId });
            this.logger.info(`Created organization "${org.slug}" (${org.id}).`);
        } catch (err) {
            if (err instanceof MeshCallError) {
                this.logger.error(err.message);
                return;
            }
            throw err;
        }
    }
}
