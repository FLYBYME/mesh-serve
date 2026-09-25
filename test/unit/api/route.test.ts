import { describe, expect, it } from 'vitest';
import { routeShape, specificity } from '../../../src/api/methods/route.js';

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
