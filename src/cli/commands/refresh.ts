import type { Command as CommanderCommand } from 'commander';
import { MeshCallError } from '@flybyme/mesh-web/net';

import { BaseCommand } from '../core/BaseCommand.js';
import { buildClient } from '../client.js';
import type { Session } from '../session.js';

/**
 * There is no cached descriptor to re-fetch any more -- generation now happens at "generate" time,
 * not per command (session.ts.md). What's still worth a command is the thing a stale descriptor used
 * to stand in for: is this host reachable, and is the stored credential still good? So "refresh"
 * became a live check, via the one call that answers both at once.
 */
export class RefreshCommand extends BaseCommand {
    public readonly name = 'refresh';
    public readonly description = 'Verify the current host is reachable and the stored credential is still valid';

    constructor(private readonly session: Session) {
        super();
    }

    public register(program: CommanderCommand): void {
        program.command(this.name).description(this.description).action(async () => this.execute());
    }

    protected async execute(): Promise<void> {
        const client = buildClient(this.session);
        try {
            const who = await client.call('identity.whoami');
            this.logger.info(`Connected to ${this.session.apiHost} as ${who.displayName} <${who.email}>.`);
        } catch (err) {
            if (err instanceof MeshCallError) {
                this.logger.error(`${this.session.apiHost}: ${err.message}`);
                return;
            }
            throw err;
        }
    }
}
