import { z } from 'zod';

import type { MetaCommand } from '../metaCommand.js';
import { persistSession } from '../session.js';

export const switchCommand: MetaCommand<string> = {
    name: 'switch',
    description: 'Change the active api host: switch <apiHost>',
    input: z.string().trim().min(1, 'Usage: switch <apiHost>'),
    async run(apiHost, { session }) {
        session.apiHost = apiHost;
        // A cached descriptor and credential belong to the host they were fetched/issued for.
        session.descriptor = undefined;
        session.credential = undefined;
        await persistSession(session);
        console.log(`Switched to ${session.apiHost}. Run "refresh" or "login" as needed.`);
    },
};
