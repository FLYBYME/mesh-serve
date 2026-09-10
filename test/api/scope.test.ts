/**
 * Which organization a request runs in (roadmap F22).
 *
 * This rule lived inline in `bin/node.mjs` with no test, which is how "a caller in two organizations
 * reads as signed out" survived until the first cluster with two tenants.
 */

import { describe, expect, it } from 'vitest';

import { isUnresolvedScope, ORGANIZATION_REQUIRED, resolveScope } from '../../src/api/methods/scope.js';

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
