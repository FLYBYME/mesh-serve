import type { Command as CommanderCommand } from 'commander';
import { z } from '@flybyme/mesh';

import { BaseCommand } from '../core/BaseCommand.js';
import { ZodToCliMapper } from '../core/ZodToCliMapper.js';
import { ApiError, callApi } from '../core/apiClient.js';
import { readSession, writeSession } from '../core/session.js';

const logoutInputSchema = z.object({});

const SIGN_OUT = { key: 'identity.ticket.signOut', method: 'POST', path: '/identity/signOut' };

/**
 * Ends the kept ticket at the api (identity.ticket.signOut), then forgets it here. Forgetting alone
 * would leave a copy of the file signed in for the rest of its 24 hours (found 10-10). An api that
 * cannot be reached is said, and the ticket is forgotten anyway.
 */
export class LogoutCommand extends BaseCommand {
    public readonly name = 'logout';
    public readonly description = 'End the kept ticket at the api, and forget it';

    public register(program: CommanderCommand): void {
        const sub = program.command(this.name).description(this.description);
        sub.action(async (opts: Record<string, unknown>) => {
            await this.execute(ZodToCliMapper.parseOptions(opts, logoutInputSchema));
        });
    }

    protected async execute(_args: z.infer<typeof logoutInputSchema>): Promise<void> {
        const session = await readSession();
        if (session.token === undefined) {
            this.logger.info('Not signed in.');
            return;
        }

        if (session.apiUrl !== undefined) {
            try {
                await callApi(session.apiUrl, SIGN_OUT, { token: session.token });
            } catch (err) {
                const why = err instanceof ApiError ? err.message : String(err);
                this.logger.warn(`The api did not end the ticket (${why}); it is forgotten here, and ends on its own when it expires.`);
            }
        }

        const { token: _token, userId: _userId, email: _email, expiresAt: _expiresAt, ...rest } = session;
        await writeSession(rest);

        this.logger.info('Signed out.');
    }
}
