/**
 * Append-only NDJSON file sink.
 *
 * ## "The database being unavailable is precisely when logs matter"
 *
 * This sink writes to disk directly, ensuring that even if MongoDB is down,
 * disconnected, or restarting, telemetry logs and server request logs continue
 * to be recorded without silent loss.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RequestLogParams, TelemSink } from './sink.js';
import type { TelemQueryInput, TelemQueryOutput, TelemRecord } from '../schema/telem.js';

export interface FileSinkOptions {
    /** File path to write NDJSON logs to. Default: `./logs/telem.ndjson`. */
    readonly filePath?: string;
    /** Max buffered records before synchronous flush. */
    readonly bufferSize?: number;
}

export class FileSink implements TelemSink {
    public readonly filePath: string;
    private stream: fs.WriteStream | undefined;
    private buffer: string[] = [];
    private readonly bufferLimit: number;
    private writing = false;

    constructor(options: FileSinkOptions = {}) {
        this.filePath = options.filePath
            ?? process.env.TELEM_LOG_FILE
            ?? path.join(process.cwd(), 'logs', 'telem.ndjson');
        this.bufferLimit = options.bufferSize ?? 50;

        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        } catch (err) {
            process.stderr.write(`[FileSink] Could not create directory for ${this.filePath}: ${String(err)}\n`);
        }
    }

    private getStream(): fs.WriteStream {
        if (!this.stream || this.stream.destroyed) {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            this.stream = fs.createWriteStream(this.filePath, { flags: 'a', encoding: 'utf8' });
            this.stream.on('error', (err) => {
                process.stderr.write(`[FileSink] WriteStream error on ${this.filePath}: ${String(err)}\n`);
            });
        }
        return this.stream;
    }

    public async write(record: TelemRecord): Promise<void> {
        await this.writeBatch([record]);
    }

    public async writeBatch(records: readonly TelemRecord[]): Promise<void> {
        if (records.length === 0) return;

        const lines = records.map((r) => JSON.stringify({
            ...r,
            timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : r.timestamp,
            createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : (r.createdAt ?? new Date().toISOString()),
        }) + '\n');

        try {
            const stream = this.getStream();
            for (const line of lines) {
                if (!stream.write(line)) {
                    await new Promise<void>((resolve) => {
                        stream.once('drain', resolve);
                    });
                }
            }
        } catch (err) {
            process.stderr.write(`[FileSink] Failed to write batch to ${this.filePath}: ${String(err)}\n`);
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

    public async flush(): Promise<void> {
        if (!this.stream || this.stream.destroyed) return;
        await new Promise<void>((resolve) => {
            this.stream?.write('', () => { resolve(); });
        });
    }

    public async close(): Promise<void> {
        if (this.stream && !this.stream.destroyed) {
            await new Promise<void>((resolve) => {
                this.stream?.end(() => { resolve(); });
            });
        }
    }

    /**
     * Fallback file query when MongoDB collection is unavailable.
     */
    public async query(input: TelemQueryInput): Promise<TelemQueryOutput> {
        if (!fs.existsSync(this.filePath)) {
            return { total: 0, events: [] };
        }

        const lines = fs.readFileSync(this.filePath, 'utf8').split('\n');
        const matched: TelemRecord[] = [];

        const fromDate = input.from ? new Date(input.from) : undefined;
        const toDate = input.to ? new Date(input.to) : undefined;

        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i]?.trim();
            if (!line) continue;

            try {
                const parsed = JSON.parse(line);
                const rec: TelemRecord = {
                    ...parsed,
                    timestamp: new Date(parsed.timestamp),
                    createdAt: parsed.createdAt ? new Date(parsed.createdAt) : undefined,
                };

                if (input.sessionId && rec.sessionId !== input.sessionId) continue;
                if (input.site && rec.site !== input.site) continue;
                if (input.level && rec.level !== input.level) continue;
                if (input.type && rec.type !== input.type) continue;
                if (fromDate && rec.timestamp < fromDate) continue;
                if (toDate && rec.timestamp > toDate) continue;

                matched.push(rec);
                if (matched.length >= input.limit) break;
            } catch {
                // Ignore malformed lines in log file
            }
        }

        return { total: matched.length, events: matched };
    }
}
