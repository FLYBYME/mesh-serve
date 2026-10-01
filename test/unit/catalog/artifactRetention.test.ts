import { describe, expect, it } from 'vitest';
import { hashesToDrop, hashesToKeep, KEEP_PER_PART, KEEP_RECENT_MS, type RetentionArtifact } from '../../../src/catalog/methods/artifactRetention.js';

const now = new Date('2026-10-01T05:00:00Z');
const daysAgo = (d: number): Date => new Date(now.getTime() - d * 86_400_000);
const build = (id: string, partId: string, hash: string, d: number, status = 'success'): RetentionArtifact => ({ id, partId, hash, status, updatedAt: daysAgo(d) });

describe('hashesToKeep', () => {
    // One part with six builds over six days, pinned to the oldest (a rollback).
    const artifacts = [1, 2, 3, 4, 5, 6].map((d) => build(`a${d}`, 'p1', `h${d}`, d));

    it('keeps what a part is pinned to, its newest builds, and nothing else of it', () => {
        const keep = hashesToKeep({ parts: [{ artifactId: 'a6' }], artifacts, releases: [], now });
        expect([...keep].sort()).toEqual(['h1', 'h2', 'h3', 'h6']);
        expect(KEEP_PER_PART).toBe(3);
    });

    it('keeps every build in a composition\'s newest releases', () => {
        const releases = [4, 5, 6, 7].map((d) => ({ compositionId: 'site', createdAt: daysAgo(d), artifacts: [{ hash: `h${d}` }] }));
        const keep = hashesToKeep({ parts: [], artifacts: [], releases, now });
        expect([...keep].sort()).toEqual(['h4', 'h5', 'h6']);
    });

    it('keeps anything just built, and never a failed build\'s (it has none)', () => {
        const fresh = build('n', 'p2', 'hn', 0);
        expect(now.getTime() - fresh.updatedAt.getTime()).toBeLessThan(KEEP_RECENT_MS);
        const keep = hashesToKeep({ parts: [], artifacts: [fresh, { id: 'f', partId: 'p2', status: 'failed', updatedAt: daysAgo(0) }], releases: [], now });
        expect([...keep]).toEqual(['hn']);
    });
});

describe('hashesToDrop', () => {
    it('drops what is stored and not kept, each once', () => {
        expect(hashesToDrop(['h1', 'h4', 'h4', 'h9'], new Set(['h1']))).toEqual(['h4', 'h9']);
    });
});
