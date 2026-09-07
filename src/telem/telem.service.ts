/**
 * The `telem` ServiceModule.
 *
 * Provides:
 * - `telem.ingest`: public ingest endpoint for browser event batches
 * - `telem.query`: internal / operator query endpoint
 * - dual-sink writes to file and collection
 * - per-site policy configuration and sampling
 * - bounded anonymous writes via rate limiting and batch caps
 */

import { randomUUID } from 'node:crypto';
import {
    ClientError,
    ServiceModule,
    type IServiceBroker,
    type IServiceContext,
} from '@flybyme/mesh';
import type { Db } from 'mongodb';

import { ingestContract, queryContract } from './contracts/telem.contract.js';
import {
    type TelemEventInput,
    type TelemIngestInput,
    type TelemIngestOutput,
    type TelemLevel,
    type TelemQueryInput,
    type TelemQueryOutput,
    type TelemRecord,
} from './schema/telem.js';
import type { TelemSink } from './sinks/sink.js';
import { FileSink } from './sinks/file-sink.js';
import { CollectionSink } from './sinks/collection-sink.js';
import { CompositeSink } from './sinks/composite-sink.js';
import { getDefaultTelemSink } from './sinks/default.js';
import { resolveTelemConfig, shouldKeepEvent, type TelemConfig } from './methods/config.js';
import { TelemRateLimiter } from './methods/rate-limit.js';

export interface TelemServiceOptions {
    readonly sink?: TelemSink;
    readonly rateLimiter?: TelemRateLimiter;
    readonly logFilePath?: string;
    readonly collectionName?: string;
    readonly db?: Db | null;
}

export class TelemService extends ServiceModule {
    public readonly domain = 'telem';

    public readonly sink: TelemSink;
    public readonly rateLimiter: TelemRateLimiter;
    private broker: IServiceBroker | undefined;

    constructor(options: TelemServiceOptions = {}) {
        super();
        this.rateLimiter = options.rateLimiter ?? new TelemRateLimiter();

        if (options.sink) {
            this.sink = options.sink;
        } else if (options.logFilePath || options.collectionName || options.db) {
            const fileSink = new FileSink({ filePath: options.logFilePath });
            const collectionSink = new CollectionSink({
                db: options.db,
                collectionName: options.collectionName,
            });
            this.sink = new CompositeSink(fileSink, collectionSink);
        } else {
            this.sink = getDefaultTelemSink();
        }

        this.mountTool(ingestContract, this.ingest.bind(this));
        this.mountTool(queryContract, this.query.bind(this));
    }

    async onStart(broker: IServiceBroker): Promise<void> {
        this.broker = broker;

        // Try to attach database provider if available
        try {
            const app = (broker as unknown as { app?: { getProvider(name: string): { db?: Db; getDb?(): Db } } }).app;
            const dbProvider = app?.getProvider?.('database');
            const db = dbProvider?.db ?? dbProvider?.getDb?.();
            if (db && this.sink instanceof CompositeSink) {
                this.sink.collectionSink.setDb(db);
            }
        } catch {
            // Database provider may not be available in standalone tests
        }
    }

    async onStop(): Promise<void> {
        await this.sink.flush?.();
        await this.sink.close?.();
    }

    /**
     * Ingest batch from browser session.
     */
    public async ingest(
        input: TelemIngestInput,
        ctx: IServiceContext,
    ): Promise<TelemIngestOutput> {
        // 1. Bound anonymous callers via rate limiter
        const allowed = this.rateLimiter.allow(input.sessionId, input.host, input.events.length);
        if (!allowed) {
            throw new ClientError('Rate limit exceeded for telemetry ingest.', 'rate_limited', 429);
        }

        // 2. Resolve site configuration (via cdn.resolve_site or site.find_one)
        let siteConfig: TelemConfig = resolveTelemConfig(null);
        let tenantId: string | undefined;

        if (input.host) {
            try {
                // cdn.resolve_site is the public unauthenticated lookup for site details
                const site = await ctx.call('cdn.resolve_site', { host: input.host }).catch(() => null);
                if (site) {
                    siteConfig = resolveTelemConfig(site as { policy?: Record<string, string> });
                    tenantId = (site as { tenantId?: string }).tenantId;
                }
            } catch {
                // If site resolution fails, use default config
            }
        }

        if (!siteConfig.enabled) {
            return { accepted: 0, dropped: input.events.length };
        }

        // 3. Filter and construct records
        const recordsToSave: TelemRecord[] = [];
        let dropped = 0;

        for (const ev of input.events) {
            const level: TelemLevel = ev.level ?? (ev.type === 'error' ? 'error' : ev.type === 'boot' ? 'info' : 'info');

            if (!shouldKeepEvent(ev.type, level, siteConfig)) {
                dropped++;
                continue;
            }

            const timestamp = ev.timestamp
                ? (ev.timestamp instanceof Date ? ev.timestamp : new Date(ev.timestamp))
                : new Date();

            // Extract details with strict privacy invariants:
            // Never store ticket values, passwords, or form contents.
            const details = this.buildEventDetails(ev);

            recordsToSave.push({
                id: ev.id || randomUUID(),
                sessionId: input.sessionId,
                site: input.host ?? '',
                tenantId,
                source: 'browser',
                type: ev.type,
                level,
                timestamp: Number.isNaN(timestamp.getTime()) ? new Date() : timestamp,
                details,
                createdAt: new Date(),
            });
        }

        // 4. Dual write to file and collection
        if (recordsToSave.length > 0) {
            await this.sink.writeBatch(recordsToSave);
        }

        return {
            accepted: recordsToSave.length,
            dropped,
        };
    }

    /**
     * Query stored telemetry events.
     */
    public async query(
        input: TelemQueryInput,
        _ctx: IServiceContext,
    ): Promise<TelemQueryOutput> {
        if (this.sink.query) {
            return await this.sink.query(input);
        }
        return { total: 0, events: [] };
    }

    /**
     * Build privacy-safe details object from incoming event.
     */
    private buildEventDetails(ev: TelemEventInput): Record<string, unknown> {
        switch (ev.type) {
            case 'call':
                return {
                    key: ev.key,
                    durationMs: ev.durationMs,
                    outcome: ev.outcome,
                    errorKind: ev.errorKind,
                    status: ev.status,
                };
            case 'boot':
                return {
                    partId: ev.partId,
                    order: ev.order,
                    durationMs: ev.durationMs,
                    bootStatus: ev.bootStatus,
                };
            case 'error':
                return {
                    message: ev.message,
                    errorKind: ev.errorKind,
                    stack: ev.stack,
                    filename: ev.filename,
                    lineno: ev.lineno,
                    colno: ev.colno,
                };
            case 'log':
                return {
                    message: ev.message,
                    logger: ev.logger,
                    data: ev.data,
                };
            case 'request':
                return {
                    method: ev.method,
                    host: ev.host,
                    path: ev.path,
                    status: ev.status,
                    durationMs: ev.durationMs,
                };
            default:
                return {};
        }
    }
}

export default TelemService;
