import type http from 'node:http';

import { scopeOfOccurrence } from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';

/**
 * `/events`: an api's exposed events, streamed to a subscriber as Server-Sent Events.
 *
 * Restored from the stream mesh-serve had before the Sep 11 rebuild (`49442ca`, removed in
 * `c68e4c0`), keeping the rule it was built around: **an event that cannot be scoped is delivered
 * to nobody.** Which scope an event belongs to comes from its definition (mesh `core/EventScope`),
 * never from the api's own record; a payload that disagrees with its definition goes to nobody,
 * operators included -- the version before that one read a disagreement as "send to everybody" and
 * put one organization's data on every connected browser.
 *
 * The wire format is what mesh-web's `net/eventsource.ts` reads: `event: <name>` + one JSON `data:`
 * line per event, `:` comments as keep-alives, and a refusal as a non-2xx with the reason as text.
 */

/** Who is listening, as delivery needs to know them. */
export interface Subscriber {
    /** The organization this subscription is for -- the api's own tenant. */
    readonly scope: string;
    /** Sees every organization's events -- but still never an unscopable one. */
    readonly operator: boolean;
}

export type Delivery =
    | { readonly deliver: true }
    | { readonly deliver: false; readonly reason: 'unscopable' | 'out-of-scope' };

export function decideDelivery(name: string, payload: unknown, subscriber: Subscriber): Delivery {
    const occurrence = scopeOfOccurrence(name, payload);
    if (occurrence === undefined) return { deliver: false, reason: 'unscopable' };
    if ('global' in occurrence) return { deliver: true };
    if (subscriber.operator) return { deliver: true };
    return occurrence.scope === subscriber.scope ? { deliver: true } : { deliver: false, reason: 'out-of-scope' };
}

/** An event this subscription will not receive, and why -- sent before anything else. */
export interface Omitted {
    readonly name: string;
    readonly reason: string;
}

export const DEFAULT_HEARTBEAT_MS = 20_000;

export interface StreamOptions {
    readonly res: http.ServerResponse;
    readonly events: readonly string[];
    readonly omitted: readonly Omitted[];
    readonly subscriber: Subscriber;
    readonly hub: EventHub;
    readonly heartbeatMs?: number;
    /** Re-resolves the subscriber each heartbeat; `undefined` means the credential is no longer valid. */
    readonly recheck: () => Promise<Subscriber | undefined>;
}

/**
 * Opens one subscription on `res` and keeps it until the client leaves or its credential stops
 * validating. Everything about the connection lives here; which events and for whom was decided
 * by the caller.
 */
export function openStream(options: StreamOptions): { close(reason?: string): void } {
    const { res, hub } = options;
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    let subscriber = options.subscriber;
    let closed = false;
    let id = 0;

    res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        // A proxy that buffers this delivers a subscription in one lump when it ends -- which is
        // never -- so the stream would look hung while working perfectly.
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
    });
    // Before any event: a client's `open` fires on the first byte, so a quiet stream must still send one.
    res.write(': open\n\n');

    const send = (event: string, data: unknown): void => {
        if (closed) return;
        id += 1;
        res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Before anything is delivered, so a client knows what it will never hear on this connection.
    if (options.omitted.length > 0) send('subscription.omitted', { events: options.omitted });

    const unsubscribes = options.events.map((name) => hub.subscribe(name, (payload) => {
        if (decideDelivery(name, payload, subscriber).deliver) send(name, payload);
    }));

    const close = (reason?: string): void => {
        if (closed) return;
        if (reason !== undefined) send('subscription.closed', { reason });
        closed = true;
        clearInterval(timer);
        for (const unsubscribe of unsubscribes) unsubscribe();
        res.end();
    };

    const timer = setInterval(() => {
        if (closed) return;
        res.write(': keepalive\n\n');
        void options.recheck().then((current) => {
            if (closed) return;
            if (current === undefined) {
                close('the credential is no longer valid');
                return;
            }
            // Not only whether they are still someone, but who: an operator role can be revoked
            // under a live stream, and delivery follows the current answer.
            subscriber = current;
        }).catch(() => {
            // A failed recheck is the identity service being unwell, not a revocation. Closing every
            // stream on a blip would turn a small outage into a stampede of reconnects.
        });
    }, heartbeatMs);
    timer.unref();

    // A client that went away, or a proxy that gave up. Nothing to report; just stop.
    res.on('close', () => close());

    return { close };
}

/**
 * One broker subscription per event name, shared by every open stream that wants it, and removed
 * when the last one closes. `broker.on` is a plain local listener, so this takes nothing from
 * anyone else subscribed to the same event (a part's own handlers, a projection).
 */
export class EventHub {
    private readonly listeners = new Map<string, { readonly off: () => void; readonly fns: Set<(payload: unknown) => void> }>();

    constructor(private readonly broker: IServiceBroker) {}

    public subscribe(name: string, fn: (payload: unknown) => void): () => void {
        let entry = this.listeners.get(name);
        if (entry === undefined) {
            const fns = new Set<(payload: unknown) => void>();
            const off = this.broker.subscribe(name, (payload) => {
                for (const listener of fns) listener(payload);
            });
            entry = { off, fns };
            this.listeners.set(name, entry);
        }
        entry.fns.add(fn);

        return () => {
            const current = this.listeners.get(name);
            if (current === undefined) return;
            current.fns.delete(fn);
            if (current.fns.size === 0) {
                current.off();
                this.listeners.delete(name);
            }
        };
    }

    /** How many event names currently hold a broker subscription -- for tests. */
    public get size(): number {
        return this.listeners.size;
    }
}
