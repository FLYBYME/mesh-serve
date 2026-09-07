/**
 * The telemetry sink interface.
 *
 * All writes go through a sink. The primary sink is a composite of:
 * - A file sink (survives database being unavailable)
 * - A collection sink (indexed in MongoDB for fast queries by UI / operators)
 */

import type { TelemQueryInput, TelemQueryOutput, TelemRecord } from '../schema/telem.js';

export interface RequestLogParams {
    readonly source: 'cdn' | 'api';
    readonly host: string;
    readonly method: string;
    readonly path: string;
    readonly status: number;
    readonly durationMs: number;
    readonly sessionId?: string;
    readonly tenantId?: string;
}

export interface TelemSink {
    write(record: TelemRecord): Promise<void> | void;
    writeBatch(records: readonly TelemRecord[]): Promise<void> | void;
    recordRequest(params: RequestLogParams): void;
    query?(input: TelemQueryInput): Promise<TelemQueryOutput>;
    flush?(): Promise<void>;
    close?(): Promise<void>;
}
