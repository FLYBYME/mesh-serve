import { describe, expect, it } from 'vitest';
import { Recent } from '../src/api/recent.js';

/** A lookup that answers when told to: what each call to it was asked, and how to answer it. */
function lookups() {
    const pending: Array<(v: string) => void> = [];
    let calls = 0;
    return {
        get calls() { return calls; },
        load: () => {
            calls++;
            return new Promise<string>((resolve) => pending.push(resolve));
        },
        answer: (v: string) => pending.shift()?.(v),
    };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('answers reused for a while', () => {
    it('without stale: the first request after the TTL waits for the whole lookup', async () => {
        let now = 0;
        const recent = new Recent<string>(10_000, 5000, () => now);
        const l = lookups();

        const first = recent.get('api.example', l.load);
        l.answer('v1');
        expect(await first).toBe('v1');

        now = 10_001;
        let answered = false;
        const late = recent.get('api.example', l.load).then((v) => { answered = true; return v; });
        await tick();
        expect(answered).toBe(false);
        l.answer('v2');
        expect(await late).toBe('v2');
    });

    it('with stale: past the TTL the last answer comes at once, one reload runs behind it, and its answer is used next (owner\'s timing, 10-16)', async () => {
        let now = 0;
        const recent = new Recent<string>(10_000, 5000, () => now, true);
        const l = lookups();

        const first = recent.get('api.example', l.load);
        l.answer('v1');
        expect(await first).toBe('v1');

        now = 10_001;
        expect(await recent.get('api.example', l.load)).toBe('v1');
        expect(await recent.get('api.example', l.load)).toBe('v1');
        expect(l.calls).toBe(2);

        l.answer('v2');
        await tick();
        expect(await recent.get('api.example', l.load)).toBe('v2');
        expect(l.calls).toBe(2);
    });

    it('with stale: a reload that fails keeps the last answer, and the next request tries again', async () => {
        let now = 0;
        const recent = new Recent<string>(10_000, 5000, () => now, true);
        let fail = false;
        let calls = 0;
        const load = async () => {
            calls++;
            if (fail) throw new Error('blip');
            return `v${calls}`;
        };

        expect(await recent.get('k', load)).toBe('v1');
        now = 10_001;
        fail = true;
        expect(await recent.get('k', load)).toBe('v1');
        await tick();
        fail = false;
        expect(await recent.get('k', load)).toBe('v1');
        await tick();
        expect(await recent.get('k', load)).toBe('v3');
    });

    it('with stale: clear() still drops it, so a change is looked up on the next request', async () => {
        const recent = new Recent<string>(10_000, 5000, () => 0, true);
        let n = 0;
        const load = async () => `v${++n}`;

        expect(await recent.get('k', load)).toBe('v1');
        recent.clear();
        expect(await recent.get('k', load)).toBe('v2');
    });
});
