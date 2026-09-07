import { Command as CommanderCommand } from 'commander';
import type { ILogger } from '@flybyme/mesh';
import { Logger, LogLevel } from '@flybyme/mesh';

export abstract class BaseCommand {
    public abstract readonly name: string;
    public abstract readonly description: string;
    public readonly aliases: string[] = [];
    public readonly category: string = 'General';

    protected logger: ILogger = new Logger(LogLevel.INFO, {}, (level, _formattedMsg, originalMsg, ...args) => {
        if (level === LogLevel.ERROR) console.error(originalMsg, ...args);
        else if (level === LogLevel.WARN) console.warn(originalMsg, ...args);
        else console.log(originalMsg, ...args);
    });

    /**
     * Registers the command with Commander.
     */
    public abstract register(program: CommanderCommand): void;

    /**
     * The main execution logic of the command.
     */
    protected abstract execute(...args: unknown[]): Promise<void>;
}
