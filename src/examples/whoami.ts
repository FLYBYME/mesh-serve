import { z } from '@flybyme/mesh';
import {
    call,
    createClient,
    defineApi,
    fetchTransport,
    withHeaders,
    MeshCallError
} from '@flybyme/mesh-web/net';

/**
 * Proof that the REST api "SDK" is standalone: nothing here is the CLI, and nothing here is
 * mesh-serve's own server code either. The shapes below are this script's own stated expectation of
 * what it's talking to -- `z` from `@flybyme/mesh` (the one every contract in this repo is written
 * against, so there's no separate zod version to drift from it) rather than a reach into
 * `../identity/contracts/*.ts`. A real consumer never has that directory to import from in the first
 * place; a script that only "works" because it happens to live in the same repo as the server is not
 * actually demonstrating the standalone claim. This is `net/api.ts`'s own rule (`spec/network.md`
 * §3.1): a generated file states the shapes it means, it does not infer them from the server's own
 * schema objects -- and a hand-written client states them by hand for the same reason.
 *
 * `call<TInput, TOutput>()`'s type parameters are compile-time only -- `createClient` never runs a
 * schema against the wire. So the schemas below are `.parse()`d explicitly, on the way out and the
 * way back, which is the actual point of having them: catching a shape that's wrong before it's sent,
 * and one that's wrong before it's trusted, not just a type that looks right to the compiler.
 *
 *   API_HOST=api.localhost API_PORT=5005 \
 *   DEMO_EMAIL=demo@example.com DEMO_PASSWORD=password123 \
 *   npx tsx src/examples/whoami.ts
 */

const apiHost = `${process.env.API_HOST ?? 'api.localhost'}:${process.env.API_PORT ?? '5005'}`;
const email = process.env.DEMO_EMAIL ?? 'demo@example.com';
const password = process.env.DEMO_PASSWORD ?? 'password123';

const issueInputSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
});
const issueOutputSchema = z.object({
    token: z.string(),
    userId: z.string(),
    expiresAt: z.number(),
});

const whoamiOutputSchema = z.object({
    userId: z.string(),
    email: z.string(),
    displayName: z.string(),
    roles: z.array(z.string()),
    organizations: z.array(z.object({
        organizationId: z.string(),
        name: z.string(),
        roleKey: z.string(),
    })),
});

const whoamiApi = defineApi({
    id: 'whoami-example',
    exposure: 'standalone-script',
    calls: {
        'identity.ticket.issue': call<z.infer<typeof issueInputSchema>, z.infer<typeof issueOutputSchema>>(
            'POST', '/identity/ticket',
        ),
        'identity.whoami': call<void, z.infer<typeof whoamiOutputSchema>>(
            'GET', '/identity/whoami',
        ),
    },
});

async function main(): Promise<void> {
    const origin = apiHost.startsWith('http://') || apiHost.startsWith('https://') ? apiHost : `http://${apiHost}`;

    // No credential yet -- this client only needs one to attach it, not to exist.
    let token: string | undefined;
    const client = createClient(whoamiApi, {
        transport: withHeaders(fetchTransport(origin), (): Record<string, string> => (token === undefined ? {} : { Authorization: `Bearer ${token}` })),
        checkExposure: false,
    });

    const ticket = issueOutputSchema.parse(
        await client.call('identity.ticket.issue', issueInputSchema.parse({ email, password })),
    );
    token = ticket.token;
    console.log(`logged in as ${ticket.userId}`);

    const who = whoamiOutputSchema.parse(await client.call('identity.whoami'));
    console.log('whoami:', who);
}

main().catch((err) => {
    console.error(err instanceof MeshCallError ? err.message : (err instanceof Error ? err.message : err));
    process.exitCode = 1;
});
