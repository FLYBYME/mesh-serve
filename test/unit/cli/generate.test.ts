import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { GenerateCommand } from '../../../src/cli/commands/generate.js';

describe('GenerateCommand CLI registration and options', () => {
    it('registers the generate command with --only option', () => {
        const program = new Command();
        const generate = new GenerateCommand();
        generate.register(program);

        const sub = program.commands.find((c) => c.name() === 'generate');
        if (sub === undefined) {
            throw new Error('Expected generate command to be registered');
        }

        const onlyOption = sub.options.find((o) => o.attributeName() === 'only');
        if (onlyOption === undefined) {
            throw new Error('Expected --only option to be registered');
        }
        expect(onlyOption.long).toBe('--only');
        expect(onlyOption.description).toContain('infer.*');
    });
});
