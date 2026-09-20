import { describe, expect, it } from 'vitest';

import { withCheckoutLock } from '../../../src/catalog/methods/build.js';

/**
 * Every part of a repo shares one working copy, so building several parts of the same repo at once
 * means concurrent `git reset --hard` and `npm ci` in one directory -- and then esbuild reading it
 * while the next build rewrites it.
 *
 * The symptom is not an obvious race. One part of a batch fails with npm's own cleanup error
 * ("Failed to remove some directories ... path argument must be of type string") while its siblings
 * from the *identical* repo succeed, which reads like a flaky npm. Found composing a console from a
 * clean database: six parts requested at once, four from mesh-core, exactly one of those four
 * failed. serve.queue runs five jobs at a time by default, so this is the ordinary case.
 *
 * These test the lock itself rather than a build, because a build takes minutes and the race is
 * probabilistic -- "it passed once" proves nothing in either direction. What is worth pinning is
 * the guarantee.
 */
describe('withCheckoutLock', () => {
    it('never lets two runs on the same directory overlap', async () => {
        let active = 0;
        let peak = 0;

        const work = async (): Promise<void> => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((r) => { setTimeout(r, 25); });
            active -= 1;
        };

        await Promise.all([
            withCheckoutLock('/repos/core', work),
            withCheckoutLock('/repos/core', work),
            withCheckoutLock('/repos/core', work),
            withCheckoutLock('/repos/core', work),
        ]);

        expect(peak).toBe(1);
    });

    it('runs them in the order they arrived', async () => {
        const order: number[] = [];
        const step = (n: number) => async (): Promise<void> => {
            await new Promise((r) => { setTimeout(r, 10); });
            order.push(n);
        };

        await Promise.all([1, 2, 3].map((n) => withCheckoutLock('/repos/core', step(n))));
        expect(order).toEqual([1, 2, 3]);
    });

    it('still runs different directories in parallel', async () => {
        // Serializing every build regardless of repo would be a real cost -- the constraint is one
        // shared checkout, not one machine.
        let active = 0;
        let peak = 0;

        const work = async (): Promise<void> => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((r) => { setTimeout(r, 25); });
            active -= 1;
        };

        await Promise.all([
            withCheckoutLock('/repos/core', work),
            withCheckoutLock('/repos/web', work),
            withCheckoutLock('/repos/operator', work),
        ]);

        expect(peak).toBe(3);
    });

    it('does not wedge the queue behind a failure', async () => {
        // A part that cannot build must not stop its siblings -- which is exactly the situation
        // that produced this bug report, since one of six failed.
        const failed = withCheckoutLock('/repos/core', async () => {
            throw new Error('npm ci exploded');
        });
        await expect(failed).rejects.toThrow('npm ci exploded');

        await expect(withCheckoutLock('/repos/core', async () => 'next one ran')).resolves.toBe('next one ran');
    });

    it('returns each run its own result', async () => {
        const [a, b] = await Promise.all([
            withCheckoutLock('/repos/core', async () => 'first'),
            withCheckoutLock('/repos/core', async () => 'second'),
        ]);

        expect(a).toBe('first');
        expect(b).toBe('second');
    });
});
