import type { MetaCommand } from '../metaCommand.js';
import { persistSession } from '../session.js';

export const logoutCommand: MetaCommand = {
    name: 'logout',
    description: 'Clear the session credential',
    async run(_input, { session }) {
        session.credential = undefined;
        await persistSession(session);
        console.log('Credential cleared.');
    },
};
