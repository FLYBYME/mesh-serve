import readline from 'node:readline';
import type { Command as CommanderCommand } from 'commander';
import { MeshCallError } from '@flybyme/mesh-web/net';

import { BaseCommand } from '../core/BaseCommand.js';
import { buildClient } from '../client.js';
import { questionHidden } from '../prompt.js';
import type { Session } from '../session.js';

/**
 * `identity.user.setPassword`, from the terminal -- the step every fresh install needs immediately
 * after its first `login`: a first-boot account is `provisional` and, per identity.service.ts's own
 * printed message, "can do nothing except set its own password" until this runs. Before this command
 * existed the only way to run it was a hand-built curl (the contract is bootstrap-exposed, but
 * nothing else in the CLI called it), which is exactly the kind of step a CLI walkthrough shouldn't
 * have to leave the CLI for.
 */
export class ClaimCommand extends BaseCommand {
    public readonly name = 'claim';
    public readonly description = 'claim [password]: set the signed-in account\'s password (also clears a first-boot account\'s provisional flag)';

    constructor(private readonly session: Session) {
        super();
    }

    public register(program: CommanderCommand): void {
        program
            .command(this.name)
            .description(this.description)
            .argument('[password]', 'At least twelve characters; prompted (with confirmation) if omitted')
            .action(async (password?: string) => this.execute(password));
    }

    protected async execute(password?: string): Promise<void> {
        if (this.session.credential === undefined) {
            this.logger.error('Not logged in. Run "login" first.');
            return;
        }

        const client = buildClient(this.session);

        const typed = password?.trim();
        const rl = typed === undefined ? readline.createInterface({ input: process.stdin, output: process.stdout }) : undefined;
        try {
            let value = typed;
            if (value === undefined && rl !== undefined) {
                for (;;) {
                    const first = await questionHidden(rl, 'New password (12+ characters): ');
                    const second = await questionHidden(rl, 'Confirm: ');
                    if (first !== second) {
                        this.logger.error('Those did not match. Try again.');
                        continue;
                    }
                    value = first;
                    break;
                }
            }

            // value is always set by here (either passed in, or the loop above only exits via its
            // `break`, which always follows an assignment) -- the fallback is unreachable in practice.
            const result = await client.call('identity.user.setPassword', { password: value ?? '' });
            this.logger.info(result.claimed ? 'Password set. Account claimed.' : 'Password set.');
        } catch (err) {
            if (err instanceof MeshCallError) {
                this.logger.error(err.message);
                return;
            }
            throw err;
        } finally {
            rl?.close();
        }
    }
}
