import type { Command as CommanderCommand } from 'commander';
import { MeshCallError } from '@flybyme/mesh-web/net';

import { BaseCommand } from '../core/BaseCommand.js';
import { buildClient } from '../client.js';
import { resolveApi } from '../resolveApi.js';
import type { Session } from '../session.js';

interface PublishArgs {
    readonly api?: string;
    readonly host: string;
    readonly ref: string;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

const REQUIRED_CONTRACTS: readonly string[] = [
    'serve.cdn.resolveHost', 'serve.release.getRelease', 'serve.part.find_one',
    'serve.artifact.requestBuild', 'serve.artifact.find', 'serve.composition.compose', 'serve.cdn.deploy',
];

/**
 * The repeat-use half of `init`: rebuild every part an already-deployed site's composition pins, at
 * a new ref, and deploy the resulting release. No repo/part/composition creation -- those are one-time
 * (`init`'s job); this is "ship what's on this ref now."
 */
export class PublishCommand extends BaseCommand {
    public readonly name = 'publish';
    public readonly description = 'publish --host <site-host> --ref <ref> [--api <id>]: rebuild and redeploy an existing site';

    constructor(private readonly session: Session) {
        super();
    }

    public register(program: CommanderCommand): void {
        program
            .command(this.name)
            .description(this.description)
            .option('--api <id>', 'The serve.api this site attaches to -- defaults to the api you\'re logged into')
            .requiredOption('--host <host>', 'The site to republish')
            .requiredOption('--ref <ref>', 'The git ref to build every part at')
            .action(async (opts: PublishArgs) => this.execute(opts));
    }

    protected async execute({ api, host, ref }: PublishArgs): Promise<void> {
        if (this.session.credential === undefined) {
            this.logger.error('Not logged in. Run "login" first.');
            return;
        }

        const client = buildClient(this.session);

        try {
            const { apiId } = await resolveApi(client, this.session, { api });
            for (const contract of REQUIRED_CONTRACTS) {
                try {
                    await client.call('serve.expose.add', { apiId, contract, role: 'operator' });
                } catch (err) {
                    if (err instanceof MeshCallError && err.error.kind === 'conflict') continue;
                    throw err;
                }
            }

            const site = await client.call('serve.cdn.resolveHost', { host });
            if (site.releaseHash === undefined) throw new Error(`"${host}" has never been deployed -- nothing to republish from.`);

            const release = await client.call('serve.release.getRelease', { hash: site.releaseHash });
            this.logger.info(`Rebuilding ${release.parts.length} part(s) from composition ${release.compositionId} at "${ref}"...`);

            for (const entry of release.parts) {
                const part = await client.call('serve.part.find_one', { query: { key: entry.partKey } });
                if (part === undefined) throw new Error(`serve.part "${entry.partKey}" no longer exists.`);

                await client.call('serve.artifact.requestBuild', { partId: part.id, ref });
                await this.waitForBuild(client, entry.partKey, part.id);
            }

            this.logger.info('Composing a new release...');
            const newRelease = await client.call('serve.composition.compose', { id: release.compositionId });
            this.logger.info(`  release ${newRelease.hash} (${newRelease.parts.length} parts pinned)`);

            const deployed = await client.call('serve.cdn.deploy', { siteId: site.id, releaseHash: newRelease.hash });
            this.logger.info(`Done. ${deployed.site.host} -> ${deployed.site.releaseHash}`);
        } catch (err) {
            if (err instanceof MeshCallError) {
                this.logger.error(err.message);
                return;
            }
            if (err instanceof Error) {
                this.logger.error(err.message);
                return;
            }
            throw err;
        }
    }

    private async waitForBuild(client: ReturnType<typeof buildClient>, partKey: string, partId: string): Promise<void> {
        for (let i = 0; i < 90; i++) {
            const artifacts = await client.call('serve.artifact.find', { query: { partId } });
            const latest = artifacts[artifacts.length - 1];
            if (latest?.status === 'success') {
                this.logger.info(`  ${partKey}: built (${latest.hash})`);
                return;
            }
            if (latest?.status === 'failed') {
                throw new Error(`${partKey} failed to build: ${latest.error ?? 'unknown error'}`);
            }
            await sleep(2000);
        }
        throw new Error(`${partKey} timed out waiting for a build`);
    }
}
