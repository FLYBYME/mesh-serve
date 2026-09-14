import { restClient } from '../cli/client.js';
import type { Session } from '../cli/session.js';

/**
 * Minimal, standalone demonstration of "how do I connect to the api and query whoami" -- the same
 * restClient/describe/call primitives the CLI itself is built on, called directly with no CLI
 * plumbing (no stored session file, no readline). Run against an already-running api server:
 *
 *   node bin/mesh-serve.mjs dev   (or however the server is started)
 *   API_HOST=api.localhost API_PORT=5005 npx tsx src/examples/accounts.ts
 */

const apiHost = `${process.env.API_HOST ?? 'api.localhost'}:${process.env.API_PORT ?? '5005'}`;
const email = process.env.DEMO_EMAIL ?? 'demo@example.com';
const password = process.env.DEMO_PASSWORD ?? 'password123';

async function main(): Promise<void> {
    // 1. Describe -- every call this script makes is looked up from what the api host actually
    // exposes, never hardcoded as a path string.
    const descriptor = await restClient.describe(apiHost);
    console.log(`connected to ${descriptor.host}, ${descriptor.calls.length} contracts exposed`);

    const session: Session = { apiHost, descriptor };

    // 2. Register -- ignored if the account already exists (identity.user.register rejects a
    // duplicate email; this script is meant to be re-run).
    const register = descriptor.calls.find((c) => c.key === 'identity.user.register');
    if (register === undefined) {
        throw new Error('identity.user.register is not exposed on this host.');
    }
    try {
        await restClient.call(session, register, { email, password, displayName: 'Demo User' });
        console.log(`registered ${email}`);
    } catch (err) {
        console.log(`register skipped: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. Issue a ticket -- exchanges the password for a bearer credential. Nothing above this line
    // needed one; everything below does.
    const issue = descriptor.calls.find((c) => c.key === 'identity.ticket.issue');
    if (issue === undefined) {
        throw new Error('identity.ticket.issue is not exposed on this host.');
    }
    const ticket = await restClient.call(session, issue, { email, password });
    const { token } = ticket.body as { token: string };
    session.credential = token;
    console.log(`issued ticket`);

    // 4. whoami -- the credential from step 3 is what makes this resolve to a real caller instead
    // of throwing UNAUTHENTICATED.
    const whoami = descriptor.calls.find((c) => c.key === 'identity.whoami');
    if (whoami === undefined) {
        throw new Error('identity.whoami is not exposed on this host.');
    }
    const who = await restClient.call(session, whoami, {});
    console.log('whoami:', who.body);
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
});
