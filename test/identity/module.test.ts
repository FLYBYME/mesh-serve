/**
 * The identity module, on a real mesh.
 *
 * A real `MeshApp` with a real registry and broker, so the contracts are really registered and the
 * inputs really validated — the same reason mesh-api's own module test exists. What is being checked
 * is not that a Map stores a user; it is the handful of decisions that are easy to get subtly wrong
 * and impossible to notice: what a validation says after a role changes, what a poller sees, and
 * what an attacker can learn from the shape of a refusal.
 */

import { MeshApp, BrokerModule, RegistryModule } from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';
import { afterEach, describe, expect, it } from 'vitest';

import { createIdentityModule, memoryStore, type IdentityModule, type IdentityStore } from '../../src/identity/index.js';

interface Node {
    readonly app: MeshApp;
    readonly module: IdentityModule;
    readonly store: IdentityStore;
    call<T>(tool: string, params: unknown, meta?: unknown): Promise<T>;
    stop(): Promise<void>;
}

let nodes: Node[] = [];

afterEach(async () => {
    for (const node of nodes) await node.stop();
    nodes = [];
});

async function boot(options: { ticketLifetimeMs?: number } = {}): Promise<Node> {
    const store = memoryStore();
    const app = new MeshApp({
        nodeID: `identity-${String(Math.random()).slice(2, 8)}`,
        namespace: 'mesh-identity-test',
    });
    app.use(new RegistryModule());
    app.use(new BrokerModule());
    await app.start();

    const module = createIdentityModule({ store, ...options });
    // After start: registerModule queues into pendingModules before it, and that flush is unawaited.
    await app.registerModule(module);

    const node: Node = {
        app,
        module,
        store,
        call: (tool, params, meta) =>
            (app as unknown as { call(t: string, p: unknown, o?: unknown): Promise<never> })
                .call(tool, params, meta === undefined ? undefined : { meta }),
        async stop() { await app.stop(); },
    };

    nodes.push(node);
    return node;
}

const register = async (node: Node, email = 'alice@example.com'): Promise<string> => {
    const { userId } = await node.call<{ userId: string }>('identity.register', {
        email, password: 'a-long-enough-password', displayName: 'Alice',
    });
    return userId;
};

const signIn = async (node: Node, email = 'alice@example.com'): Promise<string> => {
    const { token } = await node.call<{ token: string }>('identity.ticket_issue', {
        email, password: 'a-long-enough-password',
    });
    return token;
};

// ---------------------------------------------------------------------------- sign in

describe('a ticket', () => {
    it('is issued for the right password and validates', async () => {
        const node = await boot();
        const userId = await register(node);
        const token = await signIn(node);

        const validation = await node.call<{ valid: boolean; userId?: string; roles?: string[]; epoch: number }>(
            'identity.ticket_validate', { ticket: token },
        );

        expect(validation.valid).toBe(true);
        expect(validation.userId).toBe(userId);
        // `public` and `authenticated` come free — one resolution path, no special cases.
        expect(validation.roles).toContain('public');
        expect(validation.roles).toContain('authenticated');
        // An epoch comes back even on a first validation, so an instance that has never polled has
        // a cursor and its first `revocations_since` asks about the right window.
        expect(typeof validation.epoch).toBe('number');
    }, 30_000);

    it('is opaque, and long', async () => {
        const node = await boot();
        await register(node);
        const token = await signIn(node);

        // Nothing verifies it by signature, so there is no signing key — and therefore no second
        // line of defence if it is guessable.
        expect(token.length).toBeGreaterThanOrEqual(48);
        expect(token).not.toContain('.');
    }, 30_000);

    it('refuses a wrong password and an unknown address the same way', async () => {
        const node = await boot();
        await register(node);

        const wrong = await node.call('identity.ticket_issue', {
            email: 'alice@example.com', password: 'not-the-password',
        }).catch((e: unknown) => String(e));

        const missing = await node.call('identity.ticket_issue', {
            email: 'nobody@example.com', password: 'a-long-enough-password',
        }).catch((e: unknown) => String(e));

        // Same message, and the dummy-hash verify makes the timing comparable too: anything else is
        // an oracle for which addresses have accounts.
        expect(String(wrong)).toContain('not valid');
        expect(String(missing)).toContain('not valid');
    }, 30_000);

    it('does not say whether an address is taken', async () => {
        const node = await boot();
        await register(node);

        const again = await node.call('identity.register', {
            email: 'alice@example.com', password: 'a-long-enough-password', displayName: 'Someone',
        }).catch((e: unknown) => String(e));

        expect(String(again)).toContain('Could not create that account');
        expect(String(again)).not.toContain('taken');
        expect(String(again)).not.toContain('exists');
    }, 30_000);

    it('stops validating once it expires', async () => {
        let clock = 1_000_000;
        const store = memoryStore();
        const app = new MeshApp({ nodeID: 'identity-exp', namespace: 'mesh-identity-test' });
        app.use(new RegistryModule());
        app.use(new BrokerModule());
        await app.start();
        await app.registerModule(createIdentityModule({ store, ticketLifetimeMs: 1_000, now: () => clock }));

        const call = (tool: string, params: unknown): Promise<never> =>
            (app as unknown as { call(t: string, p: unknown): Promise<never> }).call(tool, params);

        await call('identity.register', { email: 'a@b.com', password: 'a-long-enough-password', displayName: 'A' });
        const { token } = await call('identity.ticket_issue', { email: 'a@b.com', password: 'a-long-enough-password' }) as unknown as { token: string };

        expect((await call('identity.ticket_validate', { ticket: token }) as unknown as { valid: boolean }).valid).toBe(true);

        clock += 2_000;
        expect((await call('identity.ticket_validate', { ticket: token }) as unknown as { valid: boolean }).valid).toBe(false);

        await app.stop();
    }, 30_000);
});

// ---------------------------------------------------------------------------- revocation

describe('revocation is a poll, not an event', () => {
    it('records an epoch a caller can poll from', async () => {
        const node = await boot();
        await register(node);
        const token = await signIn(node);

        const { epoch } = await node.call<{ revoked: number; epoch: number }>(
            'identity.ticket_revoke', { token, reason: 'signed out' },
        );

        expect(epoch).toBeGreaterThan(0);
        expect((await node.call<{ valid: boolean }>('identity.ticket_validate', { ticket: token })).valid).toBe(false);

        // The whole point of auth §3.1: an instance that was *not listening* asks what changed, and
        // is told. The event it missed cost it latency, not correctness.
        const since = await node.call<{ epoch: number; revocations: { subject: string }[]; truncated: boolean }>(
            'identity.revocations_since', { epoch: 0 },
        );

        expect(since.revocations.map((r) => r.subject)).toContain(token);
        expect(since.epoch).toBe(epoch);
        expect(since.truncated).toBe(false);
    }, 30_000);

    it('gives a poller only what it has not seen', async () => {
        const node = await boot();
        await register(node);

        const first = await signIn(node);
        const second = await signIn(node);

        const one = await node.call<{ epoch: number }>('identity.ticket_revoke', { token: first });
        await node.call('identity.ticket_revoke', { token: second });

        const caughtUp = await node.call<{ revocations: { subject: string }[] }>(
            'identity.revocations_since', { epoch: one.epoch },
        );

        // Strictly after the cursor: a poller that re-processed its own last epoch would do the work
        // twice on every poll, forever.
        expect(caughtUp.revocations.map((r) => r.subject)).toEqual([second]);
    }, 30_000);

    it('revokes every ticket a principal holds, as one row', async () => {
        const node = await boot();
        await register(node);
        const first = await signIn(node);
        const second = await signIn(node);
        const userId = (await node.call<{ userId?: string }>('identity.ticket_validate', { ticket: first })).userId!;

        const result = await node.call<{ revoked: number; epoch: number }>(
            'identity.ticket_revoke', { userId, reason: 'suspended' },
        );

        expect(result.revoked).toBe(2);

        const since = await node.call<{ revocations: { kind: string; subject: string }[] }>(
            'identity.revocations_since', { epoch: 0 },
        );

        // One `principal` row rather than one per ticket: a poller that drops everything for this
        // user is correct and cheaper, and a ticket issued a moment later is covered by it.
        expect(since.revocations).toEqual([{ kind: 'principal', subject: userId, at: expect.any(Number), epoch: expect.any(Number) }]);
        expect((await node.call<{ valid: boolean }>('identity.ticket_validate', { ticket: second })).valid).toBe(false);
    }, 30_000);

    it('allocates epochs in the store, so two revocations cannot collide', async () => {
        const node = await boot();
        await register(node);
        const a = await signIn(node);
        const b = await signIn(node);

        // Concurrent. A caller computing `max + 1` would read the same maximum twice and write one
        // epoch twice, and a poller asking for "everything after N" would silently miss one.
        const [one, two] = await Promise.all([
            node.call<{ epoch: number }>('identity.ticket_revoke', { token: a }),
            node.call<{ epoch: number }>('identity.ticket_revoke', { token: b }),
        ]);

        expect(one.epoch).not.toBe(two.epoch);
        expect((await node.call<{ revocations: unknown[] }>('identity.revocations_since', { epoch: 0 })).revocations)
            .toHaveLength(2);
    }, 30_000);
});

// ---------------------------------------------------------------------------- authority

describe('a ticket is identity, not authority', () => {
    it('reads roles from the user, so a change since issue applies', async () => {
        const node = await boot();
        const userId = await register(node);
        const token = await signIn(node);

        await node.store.updateUser(userId, { roles: ['operator'] });

        // The ticket says who you are. What you may do is looked up now — otherwise granting or
        // removing a role would not take effect until everyone signed out and in again.
        const validation = await node.call<{ roles?: string[] }>('identity.ticket_validate', { ticket: token });
        expect(validation.roles).toContain('operator');
    }, 30_000);

    it('refuses a suspended principal even with a live ticket', async () => {
        const node = await boot();
        const userId = await register(node);
        const token = await signIn(node);

        await node.store.updateUser(userId, { suspendedAt: Date.now(), suspendedReason: 'abuse' });

        expect((await node.call<{ valid: boolean }>('identity.ticket_validate', { ticket: token })).valid).toBe(false);
    }, 30_000);

    it('answers whether a set of roles permits a contract', async () => {
        const node = await boot();
        await node.store.addGrant({ roleKey: 'author', contract: 'post.*' });

        expect((await node.call<{ permitted: boolean }>('identity.permits', { roles: ['author'], contract: 'post.list' })).permitted).toBe(true);
        expect((await node.call<{ permitted: boolean }>('identity.permits', { roles: ['public'], contract: 'post.list' })).permitted).toBe(false);
    }, 30_000);

    it('ensures the builtin roles exist at start', async () => {
        const node = await boot();

        // A deployment with no `public` role cannot answer an anonymous request at all — not a state
        // it should be possible to configure into, so it is ensured rather than migrated.
        expect((await node.store.listRoles()).map((r) => r.key).sort()).toEqual(['authenticated', 'public']);
    }, 30_000);
});

describe('whoami', () => {
    it('reports the caller the API resolved, and their organizations', async () => {
        const node = await boot();
        const userId = await register(node);

        const org = await node.store.createOrganization({ slug: 'acme', name: 'Acme', ownerId: userId });
        await node.store.createMembership({
            userId, organizationId: org.id, roleKey: 'owner', joinedAt: Date.now(),
        });

        const me = await node.call<{ userId: string; organizations: { name: string; roleKey: string }[] }>(
            'identity.whoami', {}, { user: { id: userId } },
        );

        expect(me.userId).toBe(userId);
        expect(me.organizations).toEqual([{ organizationId: org.id, name: 'Acme', roleKey: 'owner' }]);
    }, 30_000);

    it('refuses when the API resolved nobody', async () => {
        const node = await boot();
        await expect(node.call('identity.whoami', {})).rejects.toThrow(/Not signed in/);
    }, 30_000);
});

describe('the module has no listener', () => {
    it('binds no port', async () => {
        const node = await boot();

        // spec/service-modules.md §2: identity answers mesh calls and emits events, and that is all.
        // A second front door to the thing everything authenticates through is not a feature.
        expect('listen' in node.module).toBe(false);
        expect('listener' in node.module).toBe(false);
    }, 30_000);
});
