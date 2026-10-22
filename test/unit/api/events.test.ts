import http from 'node:http';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { defineEvent, z } from '@flybyme/mesh';
import { decideDelivery, openStream, type Subscriber } from '../../../src/api/methods/events.js';

const scopedEvent = defineEvent('unittest.scoped', z.object({
    tenantId: z.string(),
    box: z.string().optional(),
    folder: z.string().optional(),
}), { scopedBy: 'tenantId' });

const globalEvent = defineEvent('unittest.global', z.object({
    box: z.string().optional(),
}), { scopedBy: 'global' });

defineEvent('unittest.unscoped', z.object({
    tenantId: z.string().optional(),
    box: z.string().optional(),
}));

declare module '@flybyme/mesh' {
    interface EventRegistry {
        'unittest.scoped': z.infer<typeof scopedEvent.schema>;
        'unittest.global': z.infer<typeof globalEvent.schema>;
    }
}

describe('decideDelivery: session subscriber delivery rules', () => {
    const subscriberA: Subscriber = {
        scope: 'org-a',
        operator: false,
        fields: { box: 'a' },
    };

    it('delivers an in-scope event when payload carries the session fields with matching value', () => {
        const payload = { tenantId: 'org-a', box: 'a' };

        const result = decideDelivery('unittest.scoped', payload, subscriberA);

        expect(result).toEqual({ deliver: true });
    });

    it('refuses an event when payload carries a different value for a session field', () => {
        const payload = { tenantId: 'org-a', box: 'b' };

        const result = decideDelivery('unittest.scoped', payload, subscriberA);

        expect(result).toEqual({ deliver: false, reason: 'out-of-scope' });
    });

    it('refuses an event when payload is missing a session field', () => {
        const payload = { tenantId: 'org-a' };

        const result = decideDelivery('unittest.scoped', payload, subscriberA);

        expect(result).toEqual({ deliver: false, reason: 'out-of-scope' });
    });

    it('refuses an event when organization scope does not match, even if session field matches', () => {
        const payload = { tenantId: 'org-other', box: 'a' };

        const result = decideDelivery('unittest.scoped', payload, subscriberA);

        expect(result).toEqual({ deliver: false, reason: 'out-of-scope' });
    });

    it('refuses an event when payload is null or not an object', () => {
        const nullScoped = decideDelivery('unittest.scoped', null, subscriberA);

        expect(nullScoped).toEqual({ deliver: false, reason: 'unscopable' });

        const nullGlobal = decideDelivery('unittest.global', null, subscriberA);

        expect(nullGlobal).toEqual({ deliver: false, reason: 'out-of-scope' });

        const stringGlobal = decideDelivery('unittest.global', 'not-an-object', subscriberA);

        expect(stringGlobal).toEqual({ deliver: false, reason: 'out-of-scope' });
    });

    it('requires every one of multiple session fields to match', () => {
        const multiSubscriber: Subscriber = {
            scope: 'org-a',
            operator: false,
            fields: { box: 'a', folder: 'inbox' },
        };

        const matchingPayload = { tenantId: 'org-a', box: 'a', folder: 'inbox' };

        const matchResult = decideDelivery('unittest.scoped', matchingPayload, multiSubscriber);

        expect(matchResult).toEqual({ deliver: true });

        const partialPayload = { tenantId: 'org-a', box: 'a' };

        const partialResult = decideDelivery('unittest.scoped', partialPayload, multiSubscriber);

        expect(partialResult).toEqual({ deliver: false, reason: 'out-of-scope' });

        const differentPayload = { tenantId: 'org-a', box: 'a', folder: 'archive' };

        const differentResult = decideDelivery('unittest.scoped', differentPayload, multiSubscriber);

        expect(differentResult).toEqual({ deliver: false, reason: 'out-of-scope' });
    });

    it('delivers a global event only when payload carries every session field', () => {
        const matchingGlobal = { box: 'a' };

        const matchResult = decideDelivery('unittest.global', matchingGlobal, subscriberA);

        expect(matchResult).toEqual({ deliver: true });

        const nonMatchingGlobal = { box: 'b' };

        const nonMatchResult = decideDelivery('unittest.global', nonMatchingGlobal, subscriberA);

        expect(nonMatchResult).toEqual({ deliver: false, reason: 'out-of-scope' });
    });

    it('refuses an unscopable event even when session fields match', () => {
        const unscopablePayload = { box: 'a' };

        const result = decideDelivery('unittest.unscoped', unscopablePayload, subscriberA);

        expect(result).toEqual({ deliver: false, reason: 'unscopable' });
    });
});

describe('decideDelivery: unchanged rules for accounts and operators', () => {
    const memberSubscriber: Subscriber = {
        scope: 'org-a',
        operator: false,
    };

    const operatorSubscriber: Subscriber = {
        scope: 'platform',
        operator: true,
    };

    it('delivers an in-scope event to an account regardless of extra fields', () => {
        const withField = { tenantId: 'org-a', box: 'a' };

        expect(decideDelivery('unittest.scoped', withField, memberSubscriber)).toEqual({ deliver: true });

        const withoutField = { tenantId: 'org-a' };

        expect(decideDelivery('unittest.scoped', withoutField, memberSubscriber)).toEqual({ deliver: true });
    });

    it('refuses an out-of-scope event to an account', () => {
        const otherOrg = { tenantId: 'org-b', box: 'a' };

        const result = decideDelivery('unittest.scoped', otherOrg, memberSubscriber);

        expect(result).toEqual({ deliver: false, reason: 'out-of-scope' });
    });

    it('delivers a global event to an account', () => {
        const globalPayload = { box: 'anything' };

        const result = decideDelivery('unittest.global', globalPayload, memberSubscriber);

        expect(result).toEqual({ deliver: true });
    });

    it('refuses an unscopable event to an account', () => {
        const unscopablePayload = { tenantId: 'org-a', box: 'a' };

        const result = decideDelivery('unittest.unscoped', unscopablePayload, memberSubscriber);

        expect(result).toEqual({ deliver: false, reason: 'unscopable' });
    });

    it('delivers an event from any organization to an operator', () => {
        const orgA = { tenantId: 'org-a', box: 'a' };

        expect(decideDelivery('unittest.scoped', orgA, operatorSubscriber)).toEqual({ deliver: true });

        const orgB = { tenantId: 'org-b', box: 'b' };

        expect(decideDelivery('unittest.scoped', orgB, operatorSubscriber)).toEqual({ deliver: true });
    });

    it('delivers a global event to an operator', () => {
        const globalPayload = { box: 'anything' };

        const result = decideDelivery('unittest.global', globalPayload, operatorSubscriber);

        expect(result).toEqual({ deliver: true });
    });

    it('refuses an unscopable event to an operator', () => {
        const unscopablePayload = { box: 'a' };

        const result = decideDelivery('unittest.unscoped', unscopablePayload, operatorSubscriber);

        expect(result).toEqual({ deliver: false, reason: 'unscopable' });
    });
});

describe('openStream heartbeat recheck for a session', () => {
    it('ends the stream when the credential stops validating', async () => {
        let validSession = true;

        const server = http.createServer((req, res) => {
            openStream({
                res,
                events: ['unittest.scoped'],
                omitted: [],
                subscriber: { scope: 'org-a', operator: false, fields: { box: 'a' } },
                hub: { subscribe: () => () => {} },
                heartbeatMs: 20,
                recheck: async () => {
                    if (validSession === false) {
                        return undefined;
                    }

                    return { scope: 'org-a', operator: false, fields: { box: 'a' } };
                },
            });
        });

        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', () => {
                resolve();
            });
        });

        const address = server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;

        const client = net.connect(port, '127.0.0.1');

        let data = '';
        client.on('data', (chunk) => {
            data += chunk.toString();
        });

        client.write('GET /events HTTP/1.1\r\nHost: localhost\r\n\r\n');

        await new Promise<void>((resolve) => {
            const check = () => {
                if (data.includes(': open')) {
                    resolve();
                } else {
                    setTimeout(check, 10);
                }
            };

            check();
        });

        validSession = false;

        await new Promise<void>((resolve) => {
            const check = () => {
                if (data.includes('the credential is no longer valid')) {
                    resolve();
                } else {
                    setTimeout(check, 10);
                }
            };

            check();
        });

        client.destroy();

        await new Promise<void>((resolve) => {
            server.close(() => {
                resolve();
            });
        });

        expect(data).toContain('the credential is no longer valid');
    });
});

