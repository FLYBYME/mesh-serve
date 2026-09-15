import type { Command as CommanderCommand } from 'commander';

import { BaseCommand } from '../core/BaseCommand.js';
import { persistSession } from '../session.js';
import type { Session } from '../session.js';

export class SwitchCommand extends BaseCommand {
    public readonly name = 'switch';
    public readonly description = 'Change the active api host: switch <apiHost>';

    constructor(private readonly session: Session) {
        super();
    }

    public register(program: CommanderCommand): void {
        program
            .command(this.name)
            .description(this.description)
            .argument('<apiHost>', 'The host to point future commands at')
            .action(async (apiHost: string) => this.execute(apiHost));
    }

    protected async execute(apiHost: string): Promise<void> {
        this.session.apiHost = apiHost;
        // A credential belongs to the host it was issued for.
        this.session.credential = undefined;
        await persistSession(this.session);
        this.logger.info(`Switched to ${this.session.apiHost}. Run "login" as needed.`);
    }
}
