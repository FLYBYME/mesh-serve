/**
 * `identity.sign_out`.
 *
 * It exists because the client generator refused something, which is the check working: mesh-auth
 * declared `identity.ticket_revoke` among the contracts it calls, and `describeExposure` answered
 * *marked internal by its own domain and cannot be exposed*. Correctly — `ticket_revoke` takes a
 * `userId`, so it ends every ticket a named person holds, and that is an operator suspending an
 * account rather than a page signing out.
 *
 * The extension had been posting to that path since it was written.
 */

import { BrokerModule, MeshApp, RegistryModule } from '@flybyme/mesh';
import { afterEach, describe, expect, it } from 'vitest';

import { createIdentityModule, memoryStore, type IdentityStore } from '../../src/identity/index.js';

const nodes: MeshApp[] = [];

afterEach(async () => {
    for (const app of nodes.splice(0)) await app.stop();
});

interface Node {
    call<T>(tool: string, params: unknown): Promise<T>;
    readonly store: IdentityStore;
}

async function boot(): Promise<Node> {
    const store = memoryStore();
    const app = new MeshApp({
        nodeID: `signout-${String(Math.random()).slice(2, 8)}`,
        namespace: 'mesh-serve-signout',
    });
    app.use(new RegistryModule());
    app.use(new BrokerModule());
    await app.start();

    // After start: registerModule queues into pendingModules before it, and that flush is unawaited.
    await app.registerModule(createIdentityModule({ store }));
    nodes.push(app);

    return {
        store,
        call: <T,>(tool: string, params: unknown): Promise<T> =>
            (app as unknown as { call(t: string, p: unknown): Promise<T> }).call(tool, params),
    };
}

const signIn = async (node: Node): Promise<string> => {
    await node.call('identity.register', {
        email: 'alice@example.com', password: 'correct horse', displayName: 'Alice',
    });
    const issued = await node.call<{ token: string }>('identity.ticket_issue', {
        email: 'alice@example.com', password: 'correct horse',
    });
    return issued.token;
};

describe('signing out', () => {
    it('ends the ticket it was given', async () => {
        const node = await boot();
        const token = await signIn(node);

        expect((await node.call<{ valid: boolean }>('identity.ticket_validate', { ticket: token })).valid)
            .toBe(true);

        await node.call('identity.sign_out', { token });

        expect((await node.call<{ valid: boolean }>('identity.ticket_validate', { ticket: token })).valid)
            .toBe(false);
    });

    it('records a revocation, so a polling API finds out', async () => {
        // The epoch is what makes revocation correct rather than likely: the mesh delivers events
        // at-most-once, so an API that missed the event still catches up on its next poll.
        const node = await boot();
        const token = await signIn(node);

        await node.call('identity.sign_out', { token });

        const since = await node.call<{ revocations: { kind: string; subject: string }[] }>(
            'identity.revocations_since', { epoch: 0 },
        );
        expect(since.revocations.some((r) => r.kind === 'ticket' && r.subject === token)).toBe(true);
    });

    it('answers the same for a ticket that was never issued', async () => {
        // The difference between "that was live" and "that was nothing" is information about a
        // credential the caller does not hold, and an endpoint that distinguished them would tell
        // an attacker holding a guessed token whether it was real.
        const node = await boot();

        const answer = await node.call<{ signedOut: true }>('identity.sign_out', {
            token: 'never-issued-at-all',
        });
        expect(answer.signedOut).toBe(true);
    });

    it('answers the same for a ticket already signed out', async () => {
        const node = await boot();
        const token = await signIn(node);

        await node.call('identity.sign_out', { token });
        const again = await node.call<{ signedOut: true }>('identity.sign_out', { token });

        expect(again.signedOut).toBe(true);
    });

    it('does not record a revocation for a ticket that never existed', async () => {
        // Otherwise a caller can make this collection grow by presenting nonsense, and every API
        // instance polling it pays for that.
        const node = await boot();
        await node.call('identity.sign_out', { token: 'nonsense' });

        const since = await node.call<{ revocations: unknown[] }>(
            'identity.revocations_since', { epoch: 0 },
        );
        expect(since.revocations).toHaveLength(0);
    });

    it('ends only the ticket it was given', async () => {
        // Two sessions for one person — a laptop and a phone. Signing out of one must not sign out
        // of the other, which is exactly what `ticket_revoke` with a userId would have done.
        const node = await boot();
        const first = await signIn(node);
        const second = await node.call<{ token: string }>('identity.ticket_issue', {
            email: 'alice@example.com', password: 'correct horse',
        });

        await node.call('identity.sign_out', { token: first });

        expect((await node.call<{ valid: boolean }>('identity.ticket_validate', { ticket: second.token })).valid)
            .toBe(true);
    });
});
