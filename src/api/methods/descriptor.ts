import crypto from 'node:crypto';

import { globalContractRegistry, isPublicContract } from '@flybyme/mesh';
import type { ToolContract } from '@flybyme/mesh';
import { zodToJsonSchema } from 'zod-to-json-schema';

import type { Expose } from '../contracts/expose.contract.js';

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

export interface ExposureDescriptor {
    readonly host: string;
    readonly base: string;
    readonly exposure: string;
    readonly shapeHash: string;
    readonly calls: readonly DescribedCall[];
}

/**
 * What a caller has to be to reach this call -- the contract's own floor and the row's extrinsic
 * gate together, because both are applied and both must pass (see gateway.ts checkGate).
 *
 * `public` now means genuinely ungated. Before the contract floor existed it meant only "this row
 * names no role", which was the same string for a contract nobody should reach anonymously.
 */
function gateOf(row: Expose, contract: ToolContract): string {
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
export function buildDescriptor(host: string, rows: readonly Expose[]): ExposureDescriptor {
    const calls: DescribedCall[] = [];

    for (const row of rows) {
        const contract = globalContractRegistry.get(row.contract);
        if (contract === undefined || !isPublicContract(contract)) {
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
            input: zodToJsonSchema(contract.inputSchema),
            output: zodToJsonSchema(contract.outputSchema),
            destructive: contract.destructive,
            stream: contract.rest.isStream,
        });
    }

    calls.sort((a, b) => a.key.localeCompare(b.key));

    const shapeHash = crypto.createHash('sha256')
        .update(JSON.stringify(calls.map((c) => ({ key: c.key, method: c.method, path: c.path, input: c.input, output: c.output }))))
        .digest('hex');

    const exposure = crypto.createHash('sha256')
        .update(JSON.stringify(calls.map((c) => ({ key: c.key, gate: c.gate }))))
        .digest('hex');

    return { host, base: API_BASE, exposure, shapeHash, calls };
}
