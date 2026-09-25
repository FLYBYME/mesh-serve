import crypto from 'node:crypto';

import { eventScope } from '@flybyme/mesh';
import type { ContractDeclaration } from '@flybyme/mesh';

import type { Expose } from '../contracts/expose.contract.js';

/**
 * How a contract is called and who may call it, whether it runs on this node or another --
 * `broker.contractDeclaration`. The api runs on one node and publishes contracts that run on others.
 */
export type DeclarationLookup = (key: string) => ContractDeclaration | undefined;

/** Every contract path is routed under this prefix -- api.service.ts strips it before matching. */
export const API_BASE = '/api';

export interface DescribedCall {
    readonly key: string;
    readonly domain: string;
    readonly action: string;
    readonly description: string;
    readonly method: string;
    readonly path: string;
    readonly gate: string;
    readonly input: unknown;
    readonly output: unknown;
    readonly destructive?: boolean;
    readonly stream?: boolean;
}

/** An event streamed over `${base}/events` -- mesh-web's `DescribedEvent`. No gate means public. */
export interface DescribedEvent {
    readonly name: string;
    readonly gate?: { readonly kind: 'role'; readonly role: string };
}

export interface ExposureDescriptor {
    readonly host: string;
    readonly base: string;
    readonly exposure: string;
    readonly shapeHash: string;
    readonly calls: readonly DescribedCall[];
    readonly events: readonly DescribedEvent[];
}

/**
 * What a caller has to be to reach this call -- the contract's own floor and the row's extrinsic
 * gate together, because both are applied and both must pass (see gateway.ts checkGate).
 *
 * `public` now means genuinely ungated. Before the contract floor existed it meant only "this row
 * names no role", which was the same string for a contract nobody should reach anonymously.
 */
function gateOf(row: Expose, contract: ContractDeclaration): string {
    const parts: string[] = [...contract.permissions];
    if (row.role !== undefined && !parts.includes(row.role)) parts.push(row.role);
    if (row.permission !== undefined) parts.push(`permission:${row.permission}`);
    return parts.length === 0 ? 'public' : parts.join('+');
}

/**
 * Joins a site's serve.expose rows against the live contract registry. A row naming a contract that
 * no longer exists, or one that isn't (or is no longer) public, is silently dropped -- defense in
 * depth: describeExposure's own write path already refuses to expose an internal contract, but a
 * stale row is checked again here rather than trusted.
 */
/**
 * A JSON Schema with every `default` removed, for hashing. A default does not change how a call is
 * made, and one computed from the clock (surfdns-repo's `grantedAt: () => new Date()`) is written
 * in as the time the schema was converted -- a new value on every request, so the shape hash never
 * matched twice and clients fetched /api/_describe before every call.
 */
function withoutDefaults(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutDefaults);
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'default').map(([key, v]) => [key, withoutDefaults(v)]));
}

export function buildDescriptor(host: string, rows: readonly Expose[], declare: DeclarationLookup): ExposureDescriptor {
    const calls: DescribedCall[] = [];
    const events: DescribedEvent[] = [];

    for (const row of rows) {
        if (row.kind === 'event') {
            // Advertised only if deliverable from here -- the same check serve.expose.add made,
            // made again rather than trusted, like a contract row's public check below.
            if (streamableFrom(row.contract)) {
                events.push({ name: row.contract, ...(row.role !== undefined ? { gate: { kind: 'role', role: row.role } } : {}) });
            }
            continue;
        }
        const contract = declare(row.contract);
        if (contract === undefined || contract.visibility !== 'public') {
            continue;
        }

        calls.push({
            key: row.contract,
            domain: contract.domain,
            action: contract.action,
            description: contract.description,
            method: contract.rest.method,
            path: contract.rest.path,
            gate: gateOf(row, contract),
            input: contract.input,
            output: contract.output,
            destructive: contract.destructive,
            stream: contract.rest.isStream,
        });
    }

    calls.sort((a, b) => a.key.localeCompare(b.key));
    events.sort((a, b) => a.name.localeCompare(b.name));

    const shapeHash = crypto.createHash('sha256')
        .update(JSON.stringify(calls.map((c) => ({ key: c.key, method: c.method, path: c.path, input: withoutDefaults(c.input), output: withoutDefaults(c.output) }))))
        .digest('hex');

    // Events are part of the gate, not the shape: they change what a site may receive, not how a
    // call is made. Appended only when present, so an api with no events keeps the exposure hash
    // every client generated before events existed was built against.
    const exposure = crypto.createHash('sha256')
        .update(JSON.stringify(calls.map((c) => ({ key: c.key, gate: c.gate }))))
        .update(events.length > 0 ? JSON.stringify(events) : '')
        .digest('hex');

    return { host, base: API_BASE, exposure, shapeHash, calls, events };
}

/** Whether an event is defined here and narrowable to somebody -- see core/EventScope in mesh. */
export function streamableFrom(name: string): boolean {
    const scope = eventScope(name);
    return scope !== undefined && (scope === 'global' || !('refusal' in scope));
}
