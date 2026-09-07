/**
 * Schemas for telemetry: browser sessions, kernel logs, contract calls,
 * boot phases, unhandled errors, and server HTTP requests.
 *
 * ## Privacy by construction
 *
 * A contract call records `key`, `durationMs`, `outcome` ('ok' | 'error'), and
 * `errorKind` when it fails. It never records input arguments, ticket tokens, or
 * form contents. What a user typed never enters this pipeline.
 */

import { z } from '@flybyme/mesh';

export const TelemLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type TelemLevel = z.infer<typeof TelemLevelSchema>;

export const TelemTypeSchema = z.enum(['log', 'call', 'boot', 'error', 'request']);
export type TelemType = z.infer<typeof TelemTypeSchema>;

export const TelemSourceSchema = z.enum(['browser', 'cdn', 'api']);
export type TelemSource = z.infer<typeof TelemSourceSchema>;

/**
 * One telemetry event received from the browser or server.
 *
 * Bounded string lengths prevent runaway memory or disk usage from malicious or
 * runaway anonymous callers.
 */
export const TelemEventInputSchema = z.object({
    id: z.string().max(64).optional(),
    timestamp: z.union([z.number(), z.string(), z.date()]).optional(),
    type: TelemTypeSchema,
    level: TelemLevelSchema.optional(),

    // --- log (from createLogBuffer or console)
    message: z.string().max(4096).optional(),
    logger: z.string().max(256).optional(),
    data: z.record(z.string(), z.unknown()).optional(),

    // --- call (contract invocation: keys and outcomes, NEVER inputs or credentials)
    key: z.string().max(256).optional(),
    durationMs: z.number().nonnegative().optional(),
    outcome: z.enum(['ok', 'error']).optional(),
    errorKind: z.string().max(256).optional(),
    status: z.number().int().optional(),

    // --- boot (part mounting phase)
    partId: z.string().max(256).optional(),
    order: z.number().int().optional(),
    bootStatus: z.enum(['mounted', 'failed', 'skipped']).optional(),

    // --- error (unhandled error or rejection)
    stack: z.string().max(8192).optional(),
    filename: z.string().max(1024).optional(),
    lineno: z.number().int().optional(),
    colno: z.number().int().optional(),

    // --- request (HTTP serving on CDN or API)
    method: z.string().max(16).optional(),
    host: z.string().max(256).optional(),
    path: z.string().max(2048).optional(),
}).strict();
export type TelemEventInput = z.infer<typeof TelemEventInputSchema>;

/**
 * Batched payload posted by the browser's telem extension.
 *
 * Bounded: at most 100 events per batch to keep anonymous writes bounded.
 */
export const TelemIngestInputSchema = z.object({
    /** Stable identifier for the browser page load / visit session. */
    sessionId: z.string().min(1).max(128),
    /** Hostname of the site generating the telemetry. */
    host: z.string().max(256).optional(),
    /** Bounded event list. */
    events: z.array(TelemEventInputSchema).min(1).max(100),
});
export type TelemIngestInput = z.infer<typeof TelemIngestInputSchema>;

export const TelemIngestOutputSchema = z.object({
    accepted: z.number().int(),
    dropped: z.number().int(),
});
export type TelemIngestOutput = z.infer<typeof TelemIngestOutputSchema>;

/**
 * Stored telemetry record in Mongo collection and NDJSON file.
 */
export const TelemRecordSchema = z.object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    site: z.string().default(''),
    tenantId: z.string().optional(),
    source: TelemSourceSchema,
    type: TelemTypeSchema,
    level: TelemLevelSchema,
    timestamp: z.date(),
    details: z.record(z.string(), z.unknown()),
    createdAt: z.date().optional(),
});
export type TelemRecord = z.infer<typeof TelemRecordSchema>;

/**
 * Query input for searching telemetry events by session, site, level, or time.
 */
export const TelemQueryInputSchema = z.object({
    sessionId: z.string().optional(),
    site: z.string().optional(),
    level: TelemLevelSchema.optional(),
    type: TelemTypeSchema.optional(),
    from: z.union([z.string(), z.date(), z.number()]).optional(),
    to: z.union([z.string(), z.date(), z.number()]).optional(),
    limit: z.number().int().min(1).max(500).default(50),
});
export type TelemQueryInput = z.infer<typeof TelemQueryInputSchema>;

export const TelemQueryOutputSchema = z.object({
    total: z.number().int(),
    events: z.array(TelemRecordSchema),
});
export type TelemQueryOutput = z.infer<typeof TelemQueryOutputSchema>;
