import { describe, expect, it } from 'vitest';
import { matchPath, routeShape, specificity } from '../../../src/api/methods/route.js';

describe('matchPath', () => {
    it('decodes a parameter', () => {
        expect(matchPath('/repos/:id', '/repos/a%20b')).toEqual({ id: 'a b' });
    });

    it('answers a malformed % with a 400, not a URIError (a 500)', () => {
        expect(() => matchPath('/repos/:id', '/repos/%E0%A4%A')).toThrow(expect.objectContaining({ status: 400, message: expect.stringMatching(/Malformed path segment/) }));
    });
});

describe('routeShape', () => {
    it('is the same route whatever the parameters are called', () => {
        expect(routeShape('get', '/repos/:id')).toBe(routeShape('GET', '/repos/:repoId'));
    });

    it('tells a literal segment from a parameter', () => {
        expect(routeShape('GET', '/repos/one')).not.toBe(routeShape('GET', '/repos/:id'));
    });

    it('tells methods apart', () => {
        expect(routeShape('GET', '/repos')).not.toBe(routeShape('POST', '/repos'));
    });
});

describe('specificity', () => {
    it('ranks a literal segment above a parameter in the same place', () => {
        expect(specificity('/repos/one')).toBeGreaterThan(specificity('/repos/:id'));
    });
});
