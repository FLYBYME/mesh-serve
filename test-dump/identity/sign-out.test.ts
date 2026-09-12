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
    /** The same call with a caller on it. `set_password` reads its subject from `meta.user.id`,
     *  because the caller *is* the subject — there is no id in its input. */
    callAs<T>(tool: string, params: unknown, userId: string): Promise<T>;
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

    const broker = app as unknown as {
        call<T>(t: string, p: unknown, o?: { meta: unknown }): Promise<T>;
    };

    return {
        store,
        call: <T,>(tool: string, params: unknown): Promise<T> => broker.call<T>(tool, params),
        callAs: <T,>(tool: string, params: unknown, userId: string): Promise<T> =>
            broker.call<T>(tool, params, { meta: { user: { id: userId } } }),
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

/**
 * **Changing a password ends every session — which for months it did not.**
 *
 * `set_password`'s own comment states the guarantee at length:
 *
 * > *"leaving the old sessions alive is exactly the case where that response does nothing … The
 * > caller's own ticket dies too, which is the honest outcome."*
 *
 * The code appended a revocation row and stopped there. `ticket_validate` decides on
 * `isLive(ticket)`, which reads `revokedAt` on the **ticket row** and knows nothing about the
 * revocation log — so a password changed *because it was believed compromised* left every session
 * holding the old one working until it expired, days later. `ticket_revoke` did it correctly, five
 * lines away, and the two never shared a path.
 *
 * Roadmap F29, and the same shape as F25: a comment promising something nothing implements, with
 * every test around it passing.
 */
describe('changing a password', () => {
    const registerAndSignIn = async (node: Node): Promise<{ userId: string; tokens: string[] }> => {
        const created = await node.call<{ userId?: string; id?: string }>('identity.register', {
            email: 'alice@example.com', password: 'correct horse', displayName: 'Alice',
        });
        const userId = created.userId ?? created.id ?? '';

        // Two sessions, because the point is the one that is *not* making the call.
        const tokens: string[] = [];
        for (let i = 0; i < 2; i += 1) {
            const issued = await node.call<{ token: string }>('identity.ticket_issue', {
                email: 'alice@example.com', password: 'correct horse',
            });
            tokens.push(issued.token);
        }
        return { userId, tokens };
    };

    const valid = async (node: Node, ticket: string): Promise<boolean> =>
        (await node.call<{ valid: boolean }>('identity.ticket_validate', { ticket })).valid;

    it('ends every session the account had, not only the one that asked', async () => {
        const node = await boot();
        const { userId, tokens } = await registerAndSignIn(node);

        expect(await valid(node, tokens[0]!)).toBe(true);
        expect(await valid(node, tokens[1]!)).toBe(true);

        await node.callAs('identity.set_password', { password: 'a different one' }, userId);

        expect(await valid(node, tokens[0]!)).toBe(false);
        expect(await valid(node, tokens[1]!)).toBe(false);
    });

    /**
     * The record and the marks answer different questions and both are needed: the marks are what
     * `ticket_validate` reads, and the row is what `revocations_since` serves an api whose ticket
     * cache is already holding a positive answer. Doing one and not the other is the bug.
     */
    it('records it once, by principal, so a polling API finds out too', async () => {
        const node = await boot();
        const { userId } = await registerAndSignIn(node);

        await node.callAs('identity.set_password', { password: 'a different one' }, userId);

        const since = await node.call<{ revocations: { kind: string; subject: string }[] }>(
            'identity.revocations_since', { epoch: 0 },
        );
        const principal = since.revocations.filter((r) => r.kind === 'principal');

        expect(principal).toHaveLength(1);
        expect(principal[0]!.subject).toBe(userId);
    });

    it('lets the account back in with the password it chose', async () => {
        const node = await boot();
        const { userId } = await registerAndSignIn(node);

        await node.callAs('identity.set_password', { password: 'a different one' }, userId);

        const issued = await node.call<{ token: string }>('identity.ticket_issue', {
            email: 'alice@example.com', password: 'a different one',
        });
        expect(await valid(node, issued.token)).toBe(true);
    });
});
