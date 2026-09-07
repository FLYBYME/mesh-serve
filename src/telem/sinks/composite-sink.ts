/**
 * Composite telemetry sink: dispatches to both FileSink and CollectionSink.
 *
 * Guarantees that even when MongoDB is offline or failing, writes succeed to file.
 */

import type { RequestLogParams, TelemSink } from './sink.js';
import type { FileSink } from './file-sink.js';
import type { CollectionSink } from './collection-sink.js';
import type { TelemQueryInput, TelemQueryOutput, TelemRecord } from '../schema/telem.js';

export class CompositeSink implements TelemSink {
    constructor(
        public readonly fileSink: FileSink,
        public readonly collectionSink: CollectionSink,
    ) {}

    public async write(record: TelemRecord): Promise<void> {
        await this.writeBatch([record]);
    }

    public async writeBatch(records: readonly TelemRecord[]): Promise<void> {
        if (records.length === 0) return;

        // Dispatches to both simultaneously. Failure in one never prevents the other.
        await Promise.allSettled([
            this.fileSink.writeBatch(records),
            this.collectionSink.writeBatch(records),
        ]);
    }

    public recordRequest(params: RequestLogParams): void {
        this.fileSink.recordRequest(params);
        this.collectionSink.recordRequest(params);
    }

    public async query(input: TelemQueryInput): Promise<TelemQueryOutput> {
        // Try collection sink first (fast index queries)
        const colResult = await this.collectionSink.query(input);
        if (colResult.total > 0 || colResult.events.length > 0) {
            return colResult;
        }

        // Fallback to file sink if database returned no results or is unavailable
        return await this.fileSink.query(input);
    }

    public async flush(): Promise<void> {
        await Promise.allSettled([
            this.fileSink.flush?.(),
            this.collectionSink.flush?.(),
        ]);
    }

    public async close(): Promise<void> {
        await Promise.allSettled([
            this.fileSink.close?.(),
            this.collectionSink.close?.(),
        ]);
    }
}
