import type { Command as CommanderCommand } from 'commander';
import { MeshCallError } from '@flybyme/mesh-web/net';

import { BaseCommand } from '../core/BaseCommand.js';
import { buildClient } from '../client.js';
import { resolveApi } from '../resolveApi.js';
import type { Session } from '../session.js';

interface ApiCreateArgs {
    readonly host: string;
    readonly tenant: string;
}

/**
 * `serve.api.create`, from the terminal. A new api starts with zero exposed contracts -- unlike the
 * bootstrap api, nothing seeds it -- so this is the first of several steps (init and, separately,
 * exposing whatever the site's own backend contracts are still need to run against it). No `--tenant`
 * default: unlike `init`/`publish`, where "the api you're logged into" is almost always the right
 * tenant, a brand new api's whole point is usually to belong to a *different* organization from the
 * one you're signed in as.
 */
export class ApiCreateCommand extends BaseCommand {
    public readonly name = 'api-create';
    public readonly description = 'api-create <host> --tenant <id>: create a serve.api for an organization';

    constructor(private readonly session: Session) {
        super();
    }

    public register(program: CommanderCommand): void {
        program
            .command(this.name)
            .description(this.description)
            .argument('<host>', 'The hostname this api will resolve on, e.g. flow-api.localhost')
            .requiredOption('--tenant <id>', 'The identity.organization this api belongs to')
            .action(async (host: string, opts: { tenant: string }) => this.execute({ host, tenant: opts.tenant }));
    }

    protected async execute({ host, tenant }: ApiCreateArgs): Promise<void> {
        if (this.session.credential === undefined) {
            this.logger.error('Not logged in. Run "login" first.');
            return;
        }

        const client = buildClient(this.session);
        try {
            const { apiId } = await resolveApi(client, this.session, {});
            try {
                await client.call('serve.expose.add', { apiId, contract: 'serve.api.create', role: 'operator' });
            } catch (err) {
                if (!(err instanceof MeshCallError && err.error.kind === 'conflict')) throw err;
            }

            const api = await client.call('serve.api.create', { tenantId: tenant, apiHost: host });
            this.logger.info(`Created api "${api.apiHost}" (${api.id}) for tenant ${api.tenantId}.`);
            this.logger.info('It exposes nothing yet -- "init"/"publish" self-expose what they need; anything else needs its own "serve.expose.add".');
        } catch (err) {
            if (err instanceof MeshCallError) {
                this.logger.error(err.message);
                return;
            }
            throw err;
        }
    }
}
