import readline from 'node:readline';
import { z } from 'zod';

import type { MetaCommand } from '../metaCommand.js';
import { persistSession } from '../session.js';
import { ensureDescriptor } from '../ensureDescriptor.js';
import { question, questionHidden } from '../prompt.js';

// Always a string from dispatchMeta (a scalar schema reads the whole remaining line, never
// undefined) -- an empty string is what "bare login, no token" looks like once it gets here.
const loginInputSchema = z.string();

export const loginCommand: MetaCommand<string> = {
    name: 'login',
    description: 'login <token> to attach a credential directly, or bare "login" to sign in with email/password',
    input: loginInputSchema,
    async run(token, ctx) {
        const { session, client } = ctx;

        if (token.trim() !== '') {
            session.credential = token.trim();
            await persistSession(session);
            console.log('Credential set.');
            return;
        }

        const descriptor = await ensureDescriptor(session, client);
        const issueCall = descriptor.calls.find((call) => call.key === 'identity.ticket.issue');
        if (issueCall === undefined) {
            console.error(`"identity.ticket.issue" is not exposed at ${session.apiHost} -- cannot sign in interactively here. Use "login <token>" instead.`);
            return;
        }

        const rl = ctx.rl ?? readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
            const email = await question(rl, 'Email: ');
            const password = await questionHidden(rl, 'Password: ');

            const result = await client.call(session, issueCall, { email, password });
            const body = result.body as { token?: unknown };
            if (typeof body.token !== 'string') {
                console.error('Login failed: no token in the response.');
                return;
            }

            session.credential = body.token;
            await persistSession(session);
            console.log('Logged in.');
        } finally {
            if (ctx.rl === undefined) {
                rl.close();
            }
        }
    },
};
