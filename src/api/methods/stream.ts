/**
 * Server-sent events, on `node:http`.
 *
 * A subscription is a `GET` that never ends. SSE rather than a WebSocket because everything here
 * flows one way — the mesh pushes, the browser listens — and a duplex transport for a simplex problem
 * buys a protocol upgrade, a framing layer and a reconnect story in exchange for nothing.
 *
 * mesh-api's version mounted a static express route at boot. This is the same rework `rest.ts` got,
 * for the same reason: **which events a subscription may receive depends on which hostname asked.**
 *
 * ## The property that is easy to lose
 *
 * A stream outlives the request that opened it — that is the point of it. So a ticket revoked five
 * minutes in must reach a connection authorised ten minutes ago, and nothing about the original
 * request will tell it. **The caller is re-resolved on every heartbeat**, and a stream whose ticket
 * has stopped being accepted is told and closed.
 *
 * Without that, revoking a session closes the door and leaves the window open.
 */

import type { ServerResponse } from 'node:http';

import { decideDelivery, type Subscriber } from './delivery.js';
import type { ExposedEvent } from './events.js';

/** How long between keepalives, and therefore how stale an authorisation may become. */
export const DEFAULT_HEARTBEAT_MS = 20_000;

export interface Stream {
    /** Offer an event to this subscriber. Delivered only if it can be narrowed to them. */
    offer(name: string, payload: unknown): void;
    /** Who is listening. Replaced on each heartbeat, because a scope can change under a stream. */
    subscriber: Subscriber;
    close(reason?: string): void;
    readonly closed: boolean;
}

export interface StreamOptions {
    readonly res: ServerResponse;
    readonly events: readonly ExposedEvent[];
    readonly subscriber: Subscriber;
    readonly heartbeatMs?: number;
    /**
     * Ask again who this is.
     *
     * `undefined` means the ticket is no longer accepted and the stream must end. Called on every
     * heartbeat rather than once at open, because a connection outlives its authorisation.
     */
    readonly recheck: () => Promise<Subscriber | undefined>;
    readonly onClose?: () => void;
}

export function openStream(options: StreamOptions): Stream {
    const { res, events } = options;
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    const byName = new Map(events.map((event) => [event.name, event]));

    let subscriber = options.subscriber;
    let closed = false;
    let id = 0;

    res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        // A proxy that buffers this delivers a subscription in one lump when it ends, which is
        // exactly never — so the stream appears to hang while working perfectly.
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        vary: 'Host',
    });

    // Before any event. A client's `onopen` fires on the first byte, so without this a subscription
    // to a quiet stream looks like a connection that failed to establish.
    res.write(': open\n\n');

    const send = (event: string, data: unknown, eventId: string): void => {
        if (closed) return;
        res.write(`id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const close = (reason?: string): void => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        if (reason !== undefined) send('subscription.closed', { reason }, 'closed');
        res.end();
        options.onClose?.();
    };

    /**
     * Keepalive, and re-authorisation, on one timer.
     *
     * Deliberately one rather than two: they answer the same question — *is this connection still
     * good* — and two timers is two things to reason about when a stream misbehaves.
     */
    const timer = setInterval(() => {
        if (closed) return;
        res.write(': keepalive\n\n');

        void options.recheck().then((current) => {
            if (closed) return;
            if (current === undefined) {
                // The ticket stopped being accepted — revoked, expired, or issued by an identity
                // this API no longer talks to. Whichever it is, this connection is over.
                close('the ticket is no longer valid');
                return;
            }
            // Not only whether they are still someone, but *who*: a scope can change under a live
            // stream, and delivery must follow the current answer rather than the one at open.
            subscriber = current;
        }).catch(() => {
            // A failed recheck is the identity service being unwell, not a revocation. Closing every
            // stream on a blip would turn a small outage into a stampede of reconnects.
        });
    }, heartbeatMs);

    // A browser that navigated away, or a proxy that gave up. Nothing to report; just stop.
    res.on('close', () => { close(); });

    return {
        get closed() { return closed; },
        get subscriber() { return subscriber; },
        set subscriber(next: Subscriber) { subscriber = next; },

        offer(name, payload) {
            if (closed) return;

            const event = byName.get(name);
            // Not exposed by this site. Reaching here at all means the broker delivered something
            // nobody subscribed to, so it is dropped rather than trusted.
            if (event === undefined) return;

            const decision = decideDelivery(
                { name: event.name, gate: event.gate, scope: event.scope },
                payload,
                subscriber,
            );
            if (!decision.deliver) return;

            id += 1;
            send(name, payload, String(id));
        },

        close,
    };
}
