/**
 * `cdn.all_sites` — every site on the cluster, for an operator.
 *
 * The third door into the `site` collection (roadmap F14). `site.find` is `scopedBy: 'tenantId'`, so
 * it answers within the caller's one organization; a cluster operator belongs to none by design, and
 * a membership granted so the scope resolves gives them *that organization's* view rather than the
 * cluster's.
 *
 * The console shipped exactly that and looked right, because the only cluster anyone had tested on
 * had one organization. So the test that matters here is the one that **crosses a tenant boundary** —
 * on a single-tenant fixture every one of these would pass against a scoped read.
 *
 * Tested against the tool directly with a stub repository, because what is being asserted is what
 * the handler builds and refuses, not what mongo does with it.
 */

import { describe, expect, it } from 'vitest';

import type { CdnService, SiteRepo } from '../../src/cdn/cdn.service.js';
import { cdn_all_sites } from '../../src/cdn/tools/all_sites.js';

interface Row { host: string; tenantId: string; releaseHash?: string }

/** Two organizations, which is the whole point — one is what a scoped read would have shown. */
const CLUSTER: readonly Row[] = [
    { host: '127.0.0.1', tenantId: 'org-platform', releaseHash: 'sha256:control' },
    { host: 'board.example.com', tenantId: 'org-acme', releaseHash: 'sha256:flowboard' },
    { host: 'shop.example.com', tenantId: 'org-acme' },
];

interface Seen { query: Record<string, unknown>; limit: number }

function service(rows: readonly Row[] = CLUSTER): { self: CdnService; calls: Seen[] } {
    const calls: Seen[] = [];
    const repo: SiteRepo = {
        async find(options) {
            calls.push({ query: options.query, limit: options.limit });

            // A deliberately literal stand-in for the two operators the handler may produce, so a
            // handler that started passing something else through would not be quietly honoured.
            const host = options.query['host'];
            const tenantId = options.query['tenantId'];
            const matches = rows.filter((r) => {
                if (typeof tenantId === 'string' && r.tenantId !== tenantId) return false;
                if (host !== undefined) {
                    const pattern = (host as { $regex?: string }).$regex;
                    if (pattern === undefined) throw new Error('host filter was not a regex');
                    if (!new RegExp(pattern, 'i').test(r.host)) return false;
                }
                return true;
            });
            return matches.slice(0, options.limit);
        },
    };

    return { self: { siteRepo: () => repo } as unknown as CdnService, calls };
}

const ctx = (roles?: string[]): never =>
    ({ meta: roles === undefined ? {} : { user: { id: 'u-1', roles } } }) as never;

const operator = (): never => ctx(['operator']);

describe('cdn.all_sites', () => {
    it('crosses the tenant boundary that site.find cannot', async () => {
        // The one assertion that fails against a scoped read. Two organizations, one answer.
        const { self } = service();

        const out = await cdn_all_sites.call(self, { limit: 200 }, operator());

        expect(out.sites.map((s) => s.host)).toEqual([
            '127.0.0.1', 'board.example.com', 'shop.example.com',
        ]);
        expect(new Set(out.sites.map((s) => s.tenantId)).size).toBe(2);
    });

    it('sends no tenant filter unless one was asked for', async () => {
        // If this ever starts carrying a scope, the contract has quietly become site.find and the
        // test above would still pass on a fixture with one organization.
        const { self, calls } = service();

        await cdn_all_sites.call(self, { limit: 200 }, operator());

        expect(calls[0]?.query).not.toHaveProperty('tenantId');
    });

    it('refuses a caller without the cluster operator role', async () => {
        const { self, calls } = service();

        await expect(cdn_all_sites.call(self, { limit: 200 }, ctx([])))
            .rejects.toThrow(/operator/i);
        await expect(cdn_all_sites.call(self, { limit: 200 }, ctx(['owner'])))
            .rejects.toThrow(/operator/i);
        await expect(cdn_all_sites.call(self, { limit: 200 }, ctx()))
            .rejects.toThrow(/operator/i);

        // Refused before the read, not after it — a check that runs after the query has already
        // enumerated the platform is not a check.
        expect(calls).toHaveLength(0);
    });

    it('narrows to one organization when an operator names one', async () => {
        const { self } = service();

        const out = await cdn_all_sites.call(self, { tenantId: 'org-acme', limit: 200 }, operator());

        expect(out.sites.map((s) => s.host)).toEqual(['board.example.com', 'shop.example.com']);
    });

    it('searches hostnames the way they are stored', async () => {
        const { self } = service();

        // Normalised, so the spelling a person types finds the row the platform wrote.
        const out = await cdn_all_sites.call(self, { search: 'BOARD.Example.com', limit: 200 }, operator());
        expect(out.sites.map((s) => s.host)).toEqual(['board.example.com']);
    });

    it('escapes the search, so a search box is not a query language', async () => {
        const { self, calls } = service();

        const out = await cdn_all_sites.call(self, { search: '.*', limit: 200 }, operator());

        // `.*` matches every hostname if it reaches mongo unescaped. Escaped, it matches none of
        // these, because no hostname contains the literal two characters.
        expect((calls[0]?.query['host'] as { $regex: string }).$regex).toBe('\\.\\*');
        expect(out.sites).toEqual([]);
    });

    it('says when the list was cut short rather than implying it is the cluster', async () => {
        const { self, calls } = service();

        const two = await cdn_all_sites.call(self, { limit: 2 }, operator());
        expect(two.sites).toHaveLength(2);
        expect(two.truncated).toBe(true);
        // One more than asked for, so "are there more" costs no second query.
        expect(calls[0]?.limit).toBe(3);

        const all = await cdn_all_sites.call(self, { limit: 200 }, operator());
        expect(all.truncated).toBe(false);
    });
});
