/**
 * MongoDB collection sink for telemetry.
 *
 * ## "The collection is what a UI reads"
 *
 * Inserts records into the `telem` collection.
 * Creates indexes on:
 *   - `sessionId` (for correlating whole browser sessions)
 *   - `site` (for per-site filtering)
 *   - `level` (for error/warn filtering)
 *   - `timestamp` (with a TTL index for automatic retention expiration)
 *
 * Failures to connect or write to MongoDB are caught and logged so that database
 * downtime never prevents the file sink or server process from functioning.
 */

import { randomUUID } from 'node:crypto';
import type { Collection, Db, Filter } from 'mongodb';
import type { RequestLogParams, TelemSink } from './sink.js';
import type { TelemQueryInput, TelemQueryOutput, TelemRecord } from '../schema/telem.js';

export interface CollectionSinkOptions {
    readonly db?: Db | null;
    readonly collectionName?: string;
    /** Retention period in seconds for TTL index. Default 30 days (2,592,000s). */
    readonly retentionSeconds?: number;
}

export interface TelemDoc {
    readonly id: string;
    readonly sessionId: string;
    readonly site: string;
    readonly tenantId?: string;
    readonly source: 'browser' | 'cdn' | 'api';
    readonly type: 'log' | 'call' | 'boot' | 'error' | 'request';
    readonly level: 'debug' | 'info' | 'warn' | 'error';
    readonly timestamp: Date;
    readonly details: Record<string, unknown>;
    readonly createdAt: Date;
}

export class CollectionSink implements TelemSink {
    private db: Db | null = null;
    public readonly collectionName: string;
    private readonly retentionSeconds: number;
    private indexesEnsured = false;

    constructor(options: CollectionSinkOptions = {}) {
        this.db = options.db ?? null;
        this.collectionName = options.collectionName ?? 'telem';
        this.retentionSeconds = options.retentionSeconds ?? (30 * 24 * 3600);
    }

    public setDb(db: Db | null): void {
        this.db = db;
        this.indexesEnsured = false;
        if (db) {
            void this.ensureIndexes();
        }
    }

    private get collection(): Collection<TelemDoc> | null {
        if (!this.db) return null;
        try {
            return this.db.collection<TelemDoc>(this.collectionName);
        } catch {
            return null;
        }
    }

    public async ensureIndexes(): Promise<void> {
        if (this.indexesEnsured || !this.db) return;
        const col = this.collection;
        if (!col) return;

        try {
            await col.createIndex({ sessionId: 1, timestamp: 1 });
            await col.createIndex({ site: 1, timestamp: -1 });
            await col.createIndex({ level: 1, timestamp: -1 });
            // TTL index for automatic retention expiration
            await col.createIndex(
                { timestamp: 1 },
                { expireAfterSeconds: this.retentionSeconds, name: 'telem_ttl' },
            );
            this.indexesEnsured = true;
        } catch (err) {
            process.stderr.write(`[CollectionSink] Failed to ensure indexes on ${this.collectionName}: ${String(err)}\n`);
        }
    }

    public async write(record: TelemRecord): Promise<void> {
        await this.writeBatch([record]);
    }

    public async writeBatch(records: readonly TelemRecord[]): Promise<void> {
        if (records.length === 0) return;
        const col = this.collection;
        if (!col) return;

        if (!this.indexesEnsured) {
            void this.ensureIndexes();
        }

        try {
            const docs: TelemDoc[] = records.map((r) => ({
                id: r.id,
                sessionId: r.sessionId,
                site: r.site,
                ...(r.tenantId ? { tenantId: r.tenantId } : {}),
                source: r.source,
                type: r.type,
                level: r.level,
                timestamp: r.timestamp instanceof Date ? r.timestamp : new Date(r.timestamp),
                details: r.details,
                createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(),
            }));

            await col.insertMany(docs, { ordered: false });
        } catch (err) {
            process.stderr.write(`[CollectionSink] Failed to insert ${records.length} records: ${String(err)}\n`);
        }
    }

    public recordRequest(params: RequestLogParams): void {
        const level = params.status >= 500 ? 'error' : params.status >= 400 ? 'warn' : 'info';
        const record: TelemRecord = {
            id: randomUUID(),
            sessionId: params.sessionId || 'srv-' + randomUUID().slice(0, 8),
            site: params.host,
            tenantId: params.tenantId,
            source: params.source,
            type: 'request',
            level,
            timestamp: new Date(),
            details: {
                method: params.method,
                host: params.host,
                path: params.path,
                status: params.status,
                durationMs: params.durationMs,
            },
            createdAt: new Date(),
        };

        void this.write(record);
    }

    public async query(input: TelemQueryInput): Promise<TelemQueryOutput> {
        const col = this.collection;
        if (!col) {
            return { total: 0, events: [] };
        }

        const filter: Record<string, unknown> = {};
        if (input.sessionId) filter['sessionId'] = input.sessionId;
        if (input.site) filter['site'] = input.site;
        if (input.level) filter['level'] = input.level;
        if (input.type) filter['type'] = input.type;

        if (input.from || input.to) {
            const timeFilter: Record<string, Date> = {};
            if (input.from) timeFilter['$gte'] = new Date(input.from);
            if (input.to) timeFilter['$lte'] = new Date(input.to);
            filter['timestamp'] = timeFilter;
        }

        try {
            const total = await col.countDocuments(filter as Filter<TelemDoc>);
            const cursor = col.find(filter as Filter<TelemDoc>)
                .sort({ timestamp: -1 })
                .limit(input.limit);

            const docs = await cursor.toArray();
            const events: TelemRecord[] = docs.map((d) => ({
                id: d.id,
                sessionId: d.sessionId,
                site: d.site,
                tenantId: d.tenantId,
                source: d.source,
                type: d.type,
                level: d.level,
                timestamp: new Date(d.timestamp),
                details: d.details ?? {},
                createdAt: d.createdAt ? new Date(d.createdAt) : undefined,
            }));

            return { total, events };
        } catch (err) {
            process.stderr.write(`[CollectionSink] Query error: ${String(err)}\n`);
            return { total: 0, events: [] };
        }
    }

    public async flush(): Promise<void> {
        // No-op for direct collection inserts
    }

    public async close(): Promise<void> {
        // Database connection lifecycle is managed by DatabaseModule
    }
}
