/**
 * identity.apiToken.issue used to mint a token for whatever userId it was handed, with whatever
 * roles it was handed, and wrote the plaintext token to the debug log (validate did too). A token
 * acts as its account, so anyone who could call issue could become anyone. These pin the rules that
 * replace that, plus the list/revoke contracts that make a long-lived token manageable at all.
 */
import { describe, expect, it, vi } from 'vitest';
import { isMeshError } from '@flybyme/mesh';

import { createMockContext } from '../helpers/mockContext.js';
import { issueApiToken } from '../../../src/identity/tools/issueApiToken.js';
import { listApiTokens } from '../../../src/identity/tools/listApiTokens.js';
import { revokeApiToken } from '../../../src/identity/tools/revokeApiToken.js';
import { validateApiToken } from '../../../src/identity/tools/validateApiToken.js';
import { hashToken } from '../../../src/identity/methods/hash.js';

const users: Record<string, { id: string; roles: string[] }> = {
    alice: { id: 'alice', roles: ['member'] },
    bob: { id: 'bob', roles: [] },
    op: { id: 'op', roles: ['operator'] },
};

function context(callerId: string | undefined, extra: Record<string, (params: { query?: Record<string, unknown>; id?: string }) => unknown> = {}) {
    return createMockContext({
        meta: callerId === undefined ? {} : { user: { id: callerId } },
        handlers: {
            'identity.user.resolve': async ({ id }) => (id !== undefined ? users[id] : undefined),
            'identity.membership.find_one': async ({ query }) =>
                query?.userId === 'alice' && query?.organizationId === 'org-1' ? { id: 'm1', roleKey: 'org-dev' } : undefined,
            'identity.role.find_one': async ({ query }) =>
                query?.key === 'org-dev' ? { key: 'org-dev', scope: 'organization', permissions: [], inherits: [] } : undefined,
            'identity.apiToken.create': async () => ({ id: 'new-token' }),
            ...extra,
        },
    });
}

async function rejection(promise: Promise<unknown>): Promise<{ status?: number; message: string }> {
    try {
        await promise;
    } catch (err) {
        if (isMeshError(err)) return { status: err.status, message: err.message };
        return { message: String(err) };
    }
    throw new Error('expected a rejection');
}

describe('identity.apiToken.issue', () => {
    it('refuses an anonymous caller', async () => {
        const { ctx } = context(undefined);
        expect((await rejection(issueApiToken({ name: 'git' }, ctx))).status).toBe(401);
    });

    it("mints the caller's own token by default, and never logs it", async () => {
        const { ctx, calls } = context('alice');
        const debug = vi.spyOn(ctx.logger, 'debug');

        const result = await issueApiToken({ name: 'git' }, ctx);

        expect(result.userId).toBe('alice');
        const created = calls.find((c) => c.action === 'identity.apiToken.create');
        expect(created?.params.userId).toBe('alice');
        expect(created?.params.tokenHash).toBe(hashToken(result.token));
        for (const args of debug.mock.calls) expect(JSON.stringify(args)).not.toContain(result.token);
    });

    it("refuses to mint a token for another account unless the caller is an operator", async () => {
        const { ctx, calls } = context('alice');
        const err = await rejection(issueApiToken({ name: 'impersonate', userId: 'bob' }, ctx));

        expect(err.status).toBe(403);
        expect(calls.some((c) => c.action === 'identity.apiToken.create')).toBe(false);
    });

    it('lets an operator mint a token for another account', async () => {
        const { ctx } = context('op');
        expect((await issueApiToken({ name: 'for-bob', userId: 'bob' }, ctx)).userId).toBe('bob');
    });

    it('refuses roles the account does not hold, naming them', async () => {
        const { ctx, calls } = context('alice');
        const err = await rejection(issueApiToken({ name: 'escalate', roles: ['member', 'operator'] }, ctx));

        expect(err.status).toBe(403);
        expect(err.message).toContain('operator');
        expect(err.message).not.toContain('member,');
        expect(calls.some((c) => c.action === 'identity.apiToken.create')).toBe(false);
    });

    it('allows roles the account does hold, including one from the organization it scopes to', async () => {
        const { ctx } = context('alice');
        const result = await issueApiToken({ name: 'ci', organizationId: 'org-1', roles: ['member', 'org-dev'] }, ctx);
        expect(result.roles).toEqual(['member', 'org-dev']);
    });

    it("refuses an organization scope the account isn't a member of", async () => {
        const { ctx } = context('bob');
        expect((await rejection(issueApiToken({ name: 'x', organizationId: 'org-1' }, ctx))).status).toBe(403);
    });
});

const aliceTokens = [
    { id: 't1', name: 'git', userId: 'alice', roles: [], tokenHash: 'secret-hash', createdAt: new Date() },
    { id: 't2', name: 'old', userId: 'alice', roles: [], tokenHash: 'other-hash', createdAt: new Date(), revokedAt: new Date() },
];

describe('identity.apiToken.list', () => {
    it("lists the caller's tokens without their hashes", async () => {
        const { ctx, calls } = context('alice', {
            'identity.apiToken.find': async ({ query }) => aliceTokens.filter((t) => t.userId === query?.userId),
        });

        const { tokens } = await listApiTokens({}, ctx);

        expect(calls.find((c) => c.action === 'identity.apiToken.find')?.params.query).toEqual({ userId: 'alice' });
        expect(tokens.map((t) => t.name)).toEqual(['git', 'old']);
        expect(JSON.stringify(tokens)).not.toContain('hash');
    });

    it("refuses another account's tokens unless the caller is an operator", async () => {
        const { ctx } = context('bob');
        expect((await rejection(listApiTokens({ userId: 'alice' }, ctx))).status).toBe(403);
    });
});

describe('identity.apiToken.revoke', () => {
    it("revokes the caller's token by name", async () => {
        const { ctx, calls } = context('alice', {
            'identity.apiToken.find': async ({ query }) => aliceTokens.filter((t) => t.userId === query?.userId && t.name === query?.name),
            'identity.apiToken.update': async () => ({}),
        });

        expect(await revokeApiToken({ name: 'git' }, ctx)).toEqual({ revoked: 1 });
        const update = calls.find((c) => c.action === 'identity.apiToken.update');
        expect(update?.params.id).toBe('t1');
        expect(update?.params.revokedAt).toBeInstanceOf(Date);
    });

    it("only ever looks within the caller's own tokens, so someone else's id is not found", async () => {
        const { ctx, calls } = context('bob', {
            'identity.apiToken.find': async ({ query }) => aliceTokens.filter((t) => t.userId === query?.userId && t.id === query?.id),
        });

        expect((await rejection(revokeApiToken({ id: 't1' }, ctx))).status).toBe(404);
        expect(calls.find((c) => c.action === 'identity.apiToken.find')?.params.query).toEqual({ id: 't1', userId: 'bob' });
    });

    it('reports 0 for a token that was already revoked', async () => {
        const { ctx } = context('alice', {
            'identity.apiToken.find': async ({ query }) => aliceTokens.filter((t) => t.name === query?.name),
        });
        expect(await revokeApiToken({ name: 'old' }, ctx)).toEqual({ revoked: 0 });
    });

    it('needs exactly one of id or name', async () => {
        const { ctx } = context('alice');
        expect((await rejection(revokeApiToken({}, ctx))).status).toBe(422);
        expect((await rejection(revokeApiToken({ id: 't1', name: 'git' }, ctx))).status).toBe(422);
    });
});

describe('identity.apiToken.validate', () => {
    it('never logs the token it was handed', async () => {
        const plaintext = 'plaintext-token-value';
        const { ctx } = context(undefined, {
            'identity.apiToken.find_one': async () => ({ id: 't1', name: 'git', userId: 'alice', roles: [], tokenHash: hashToken(plaintext) }),
        });
        const debug = vi.spyOn(ctx.logger, 'debug');

        expect((await validateApiToken({ token: plaintext }, ctx)).valid).toBe(true);
        for (const args of debug.mock.calls) expect(JSON.stringify(args)).not.toContain(plaintext);
    });
});
