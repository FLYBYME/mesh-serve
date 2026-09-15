import type { Command as CommanderCommand } from 'commander';

import { BaseCommand } from '../core/BaseCommand.js';
import { persistSession } from '../session.js';
import type { Session } from '../session.js';

export class LogoutCommand extends BaseCommand {
    public readonly name = 'logout';
    public readonly description = 'Clear the session credential';

    constructor(private readonly session: Session) {
        super();
    }

    public register(program: CommanderCommand): void {
        program.command(this.name).description(this.description).action(async () => this.execute());
    }

    protected async execute(): Promise<void> {
        this.session.credential = undefined;
        await persistSession(this.session);
        this.logger.info('Credential cleared.');
    }
}
