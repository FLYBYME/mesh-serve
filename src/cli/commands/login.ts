import readline from 'node:readline';
import type { Command as CommanderCommand } from 'commander';
import { MeshCallError } from '@flybyme/mesh-web/net';

import { BaseCommand } from '../core/BaseCommand.js';
import { buildClient } from '../client.js';
import { persistSession } from '../session.js';
import { question, questionHidden } from '../prompt.js';
import type { Session } from '../session.js';

export class LoginCommand extends BaseCommand {
    public readonly name = 'login';
    public readonly description = 'login [token] to attach a credential directly, or bare "login" to sign in with email/password';

    constructor(private readonly session: Session) {
        super();
    }

    public register(program: CommanderCommand): void {
        program
            .command(this.name)
            .description(this.description)
            .argument('[token]', 'Attach this bearer token directly instead of prompting for email/password')
            .action(async (token?: string) => this.execute(token));
    }

    protected async execute(token?: string): Promise<void> {
        if (token !== undefined && token.trim() !== '') {
            this.session.credential = token.trim();
            await persistSession(this.session);
            this.logger.info('Credential set.');
            return;
        }

        const client = buildClient(this.session);
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
            const email = await question(rl, 'Email: ');
            const password = await questionHidden(rl, 'Password: ');

            const result = await client.call('identity.ticket.issue', { email, password });
            this.session.credential = result.token;
            await persistSession(this.session);
            this.logger.info(`Logged in as ${result.userId}.`);
        } catch (err) {
            if (err instanceof MeshCallError) {
                this.logger.error(err.message);
                return;
            }
            throw err;
        } finally {
            rl.close();
        }
    }
}
