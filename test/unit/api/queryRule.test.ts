import { describe, expect, it } from 'vitest';
import { firstOperator } from '../../../src/api/methods/queryRule.js';

describe('firstOperator: a query over HTTP is field equality only', () => {
    it('finds the operator that walked every organization anonymously', () => {
        expect(firstOperator({ slug: { $ne: 'platform' } })).toBe('query.slug.$ne');
    });

    it('finds operators at the top, deep, and inside arrays', () => {
        expect(firstOperator({ $or: [{ a: 1 }] })).toBe('query.$or');
        expect(firstOperator({ a: { b: { $gt: 1 } } })).toBe('query.a.b.$gt');
        expect(firstOperator({ tags: [{ $regex: '.*' }] })).toBe('query.tags[0].$regex');
        expect(firstOperator({ $where: 'sleep(1000)' })).toBe('query.$where');
    });

    it('lets plain equality through, dotted paths and nested values included', () => {
        expect(firstOperator({ slug: 'platform' })).toBeUndefined();
        expect(firstOperator({ 'item.tenantId': 't', count: 2, ok: true, none: null })).toBeUndefined();
        expect(firstOperator({ labels: { role: 'hub' }, list: ['a', 'b'] })).toBeUndefined();
        expect(firstOperator(undefined)).toBeUndefined();
        expect(firstOperator('slug')).toBeUndefined();
    });
});
