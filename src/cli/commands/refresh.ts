import type { MetaCommand } from '../metaCommand.js';
import { persistSession } from '../session.js';

export const refreshCommand: MetaCommand = {
    name: 'refresh',
    description: 'Re-fetch /api/_describe from the current host and cache it',
    async run(_input, { session, client }) {
        session.descriptor = await client.describe(session.apiHost);
        await persistSession(session);
        console.log(`Refreshed -- ${session.descriptor.calls.length} calls available.`);
    },
};
