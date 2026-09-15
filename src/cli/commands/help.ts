import type { Command as CommanderCommand } from 'commander';

import { BaseCommand } from '../core/BaseCommand.js';
import { CommandRegistry } from '../core/CommandRegistry.js';
import type { Session } from '../session.js';

export class HelpCommand extends BaseCommand {
    public readonly name = 'help';
    public readonly description = 'Show this message';

    constructor(private readonly registry: CommandRegistry, private readonly program: CommanderCommand, private readonly session: Session) {
        super();
    }

    public register(program: CommanderCommand): void {
        program.command(this.name).description(this.description).action(async () => this.execute());
    }

    protected async execute(): Promise<void> {
        this.registry.printHelp(this.program);
        this.logger.info(`Current host: ${this.session.apiHost}${this.session.credential !== undefined ? ' (logged in)' : ''}`);
    }
}
