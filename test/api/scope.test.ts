/**
 * Which organization a request runs in (roadmap F22).
 *
 * This rule lived inline in `bin/node.mjs` with no test, which is how "a caller in two organizations
 * reads as signed out" survived until the first cluster with two tenants.
 */

import { readFileSync } from 'node:fs';

import { defineCrud, z } from '@flybyme/mesh';
import { describe, expect, it } from 'vitest';

import { isUnresolvedScope, ORGANIZATION_REQUIRED, resolveScope } from '../../src/api/methods/scope.js';
import { describeExposure } from '../../src/api/schema/descriptor.js';

const PLATFORM = 'org-platform';
const TENANT = 'org-tenant';
const STRANGER = 'org-stranger';
const both = [{ organizationId: PLATFORM }, { organizationId: TENANT }];

describe('resolveScope', () => {
    it('honours a header naming one of the caller\'s own organizations', () => {
        expect(resolveScope({ memberships: both, requestedScope: TENANT, siteScope: PLATFORM }))
            .toEqual({ authorized: true, resolvedScope: TENANT });
    });

    it('refuses a header naming an organization the caller is not in, as not found', () => {
        expect(resolveScope({ memberships: both, requestedScope: STRANGER, siteScope: PLATFORM }))
            .toMatchObject({ authorized: false, status: 404, code: 'no_such_organization' });
    });

    it('needs no header for a caller in exactly one organization', () => {
        expect(resolveScope({ memberships: [{ organizationId: TENANT }], requestedScope: undefined, siteScope: PLATFORM }))
            .toEqual({ authorized: true, resolvedScope: TENANT });
    });

    /**
     * **The fix.** The operator after a second tenant is seeded: an owner of both. On the console's
     * hostname they mean Platform, on flowboard's they mean the tenant — and before this they got no
     * scope at all and every scoped read answered 401.
     */
    it('picks the site\'s own organization for a caller in several, when they belong to it', () => {
        expect(resolveScope({ memberships: both, requestedScope: undefined, siteScope: PLATFORM }))
            .toEqual({ authorized: true, resolvedScope: PLATFORM });
        expect(resolveScope({ memberships: both, requestedScope: undefined, siteScope: TENANT }))
            .toEqual({ authorized: true, resolvedScope: TENANT });
    });

    /** The site chooses among memberships and cannot add one. This is the property that makes it safe. */
    it('never resolves to the site\'s organization for a caller who is not in it', () => {
        expect(resolveScope({ memberships: both, requestedScope: undefined, siteScope: STRANGER }))
            .toEqual({ authorized: true });
        expect(resolveScope({ memberships: [], requestedScope: undefined, siteScope: STRANGER }))
            .toEqual({ authorized: true });
    });

    it('lets an explicit header win over the site', () => {
        expect(resolveScope({ memberships: both, requestedScope: TENANT, siteScope: PLATFORM }))
            .toEqual({ authorized: true, resolvedScope: TENANT });
    });
});

describe('recognising the refusal a scoped read makes with no scope', () => {
    /** The exact text mesh writes. If mesh ever rewords it, this is the test that says so. */
    it('matches what the database middleware raises, for either scope field', () => {
        expect(isUnresolvedScope(new Error(
            'Scoped collection "site" requires a resolved "tenantId" scope, but none was provided in call context.',
        ))).toBe(true);
        expect(isUnresolvedScope(new Error(
            'Scoped collection "membership" requires a resolved "organizationId" scope, but none was provided in call context.',
        ))).toBe(true);
    });

    it('does not match an ordinary authentication failure', () => {
        expect(isUnresolvedScope(new Error('That ticket is not accepted.'))).toBe(false);
        expect(isUnresolvedScope('requires a resolved "x" scope')).toBe(false);
    });

    it('re-words it as a request to name an organization, not to sign in', () => {
        expect(ORGANIZATION_REQUIRED.status).toBe(400);
        expect(ORGANIZATION_REQUIRED.message).toContain('x-organization');
        expect(ORGANIZATION_REQUIRED.message).not.toMatch(/sign in/i);
    });
});

/**
 * **F23 — the same question, asked from the MCP surface.**
 *
 * F22 gave the gate a `siteScope` and wired it at the api's four call sites. `McpService` calls the
 * same gate and was not wired, so an agent whose account belonged to two organizations was told to
 * name one over a protocol with nowhere to put the answer. It went unnoticed because every account
 * on every cluster so far belonged to exactly one — `resolveScope`'s "only membership" branch
 * answered before the site was ever consulted.
 *
 * It became load-bearing the day flowboard's own collections were scoped (`flowboard B1`): before
 * that, an agent dispatching a card read an unscoped collection and no scope was required at all.
 */
describe('the MCP surface knows whose site it is serving', () => {
    const ThingSchema = z.object({ name: z.string(), tenantId: z.string() });
    const thingCrud = defineCrud('thing', ThingSchema, {
        pluralPath: 'things',
        scopedBy: 'tenantId',
        visibility: { find: 'public' },
        dependencies: [],
    });
    const entries = [{ contract: thingCrud.find, auth: 'user' as const }];

    it('carries the site\'s organization onto the descriptor', () => {
        const descriptor = describeExposure(entries, { application: 'flowboard', siteScope: TENANT });
        expect(descriptor.siteScope).toBe(TENANT);
    });

    /**
     * Absent, not empty. A descriptor built without one must not claim an organization — the gate
     * reads `undefined` as *this site cannot help you choose*, and `''` would be a membership check
     * against a name nobody holds.
     */
    it('omits it entirely when the site has none', () => {
        const descriptor = describeExposure(entries, { application: 'flowboard' });
        expect('siteScope' in descriptor).toBe(false);
    });

    /**
     * Who owns the hostname is not part of what the hostname exposes. Folding it into either hash
     * would report every generated browser client stale the first time a site changed hands, and
     * would make two organizations running the same release look like two different APIs.
     */
    it('changes neither hash', () => {
        const plain = describeExposure(entries, { application: 'flowboard' });
        const owned = describeExposure(entries, { application: 'flowboard', siteScope: TENANT });
        expect(owned.exposure).toBe(plain.exposure);
        expect(owned.shapeHash).toBe(plain.shapeHash);
    });

    /**
     * **The bug was an omission at a call site, so this is what catches the next one.**
     *
     * Reading the source rather than the behaviour, because `McpService` builds an HTTP server in
     * its constructor and its gate calls are behind `#private` methods — there is no seam to assert
     * this through, and a rule nothing checks is how the first four call sites got wired and the
     * fourth file did not. Every `executeGate` on this surface answers *which organization* and
     * must be handed the site's.
     */
    it('passes it at every gate call the MCP surface makes', () => {
        const source = readFileSync(new URL('../../src/api/mcp.service.ts', import.meta.url), 'utf8');
        const invocations = source.split('executeGate({').slice(1);

        expect(invocations.length).toBeGreaterThan(0);
        for (const invocation of invocations) {
            expect(invocation.slice(0, invocation.indexOf('});'))).toContain('siteScope');
        }
    });
});
