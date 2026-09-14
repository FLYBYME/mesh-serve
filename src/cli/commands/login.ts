import { z } from 'zod';

import type { MetaCommand } from '../metaCommand.js';
import { persistSession } from '../session.js';

export const loginCommand: MetaCommand<string> = {
    name: 'login',
    description: 'Attach a bearer credential to this session: login <token>',
    input: z.string().trim().min(1, 'Usage: login <token>'),
    async run(token, { session }) {
        session.credential = token;
        await persistSession(session);
        console.log('Credential set.');
    },
};
