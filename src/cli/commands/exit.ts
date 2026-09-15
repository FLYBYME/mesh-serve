import type readline from 'node:readline';
import type { Command as CommanderCommand } from 'commander';

import { BaseCommand } from '../core/BaseCommand.js';

/** Filled in by the REPL once its readline interface exists; absent in one-shot mode. */
export interface ReplHandle {
    rl?: readline.Interface;
}

export class ExitCommand extends BaseCommand {
    public readonly name = 'exit';
    public readonly description = 'Quit the REPL';
    public override readonly aliases = ['quit'];

    constructor(private readonly handle: ReplHandle) {
        super();
    }

    public register(program: CommanderCommand): void {
        program.command(this.name).alias('quit').description(this.description).action(async () => this.execute());
    }

    protected async execute(): Promise<void> {
        if (this.handle.rl !== undefined) {
            this.handle.rl.close();
        } else {
            process.exit(0);
        }
    }
}
