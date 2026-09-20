import { describe, expect, it } from 'vitest';
import { createMockContext } from '../helpers/mockContext.js';
import { decide } from '../../../src/hold/tools/decide.js';

/**
 * The real bug this domain had before leaderScoped + withLock: two concurrent decide() calls for
 * the same hold could both read status: 'held' before either wrote, and both replay the frozen
 * call. This proves that's actually closed, not just typechecked -- a shared mock ctx (one real
 * lockBroker underneath, same as production) racing two decide() calls against mutable row state
 * that only one of them should ever be allowed to move out of 'held'.
 */
describe('hold decide: concurrency safety', () => {
    it('two concurrent decide calls on the same hold only replay the frozen call once', async () => {
        let row: {
            id: string;
            status: 'held' | 'released' | 'rejected' | 'expired';
            call: string;
            input: Record<string, unknown>;
            tenantId: string;
            requestedBy: { userId: string };
        } = {
            id: 'hold-1',
            status: 'held',
            call: 'test.replay',
            input: { foo: 'bar' },
            tenantId: 'tenant-1',
            requestedBy: { userId: 'agent-user-1' },
        };

        let replayCount = 0;

        const { ctx } = createMockContext({
            handlers: {
                'serve.hold.resolve': async () => ({ ...row }),
                'serve.hold.update': async (params: { id: string; status: typeof row.status }) => {
                    row = { ...row, status: params.status };
                    return row;
                },
                'test.replay': async () => {
                    replayCount++;
                    // Widen the race window -- without withLock, both concurrent decide() calls
                    // would read status: 'held' well before either reaches this point.
                    await new Promise((r) => setTimeout(r, 30));
                    return { ok: true };
                },
            },
        });

        const [first, second] = await Promise.allSettled([
            decide({ holdId: 'hold-1', approved: true }, ctx),
            decide({ holdId: 'hold-1', approved: true }, ctx),
        ]);

        expect(replayCount).toBe(1);

        const fulfilled = [first, second].filter((r) => r.status === 'fulfilled');
        const rejected = [first, second].filter((r) => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        expect((fulfilled[0] as PromiseFulfilledResult<{ status: string }>).value.status).toBe('released');
        expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/was already released/);

        expect(row.status).toBe('released');
    });

    it('a rejected decide does not block a later decide call on a different hold', async () => {
        const holds: Record<string, { status: string }> = {
            'hold-a': { status: 'held' },
            'hold-b': { status: 'held' },
        };

        const { ctx } = createMockContext({
            handlers: {
                'serve.hold.resolve': async (params: { id: string }) => ({
                    id: params.id,
                    status: holds[params.id]!.status,
                    call: 'test.replay',
                    input: {},
                    tenantId: 'tenant-1',
                    requestedBy: { userId: 'agent-user-1' },
                }),
                'serve.hold.update': async (params: { id: string; status: string }) => {
                    holds[params.id]!.status = params.status;
                    return { id: params.id, ...holds[params.id] };
                },
            },
        });

        const rejectedA = await decide({ holdId: 'hold-a', approved: false }, ctx);
        expect(rejectedA.status).toBe('rejected');

        const rejectedB = await decide({ holdId: 'hold-b', approved: false }, ctx);
        expect(rejectedB.status).toBe('rejected');
    });
});
