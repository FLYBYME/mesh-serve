import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

import {
    TelemIngestInputSchema,
    type TelemRecord,
    TelemService,
    FileSink,
    CollectionSink,
    CompositeSink,
    resolveTelemConfig,
    shouldKeepEvent,
    TelemRateLimiter,
    type TelemSink,
    type RequestLogParams,
} from '../../src/telem/index.js';
import { CdnService } from '../../src/cdn/cdn.service.js';
import { ApiService } from '../../src/api/api.service.js';

describe('telemetry ingest schema and privacy invariants', () => {
    it('accepts valid batched events from a browser session', () => {
        const payload = {
            sessionId: 'sess-12345',
            host: 'example.com',
            events: [
                {
                    type: 'log' as const,
                    level: 'info' as const,
                    message: 'Kernel booted',
                    logger: 'kernel',
                },
                {
                    type: 'boot' as const,
                    partId: 'app-main',
                    order: 1,
                    durationMs: 42,
                    bootStatus: 'mounted' as const,
                },
                {
                    type: 'call' as const,
                    key: 'identity.whoami',
                    durationMs: 15,
                    outcome: 'ok' as const,
                    status: 200,
                },
                {
                    type: 'error' as const,
                    message: 'Uncaught TypeError: cannot read properties of undefined',
                    stack: 'TypeError: ... at line 10',
                },
                {
                    type: 'request' as const,
                    method: 'GET',
                    host: 'example.com',
                    path: '/index.html',
                    status: 200,
                    durationMs: 5,
                },
            ],
        };

        const parsed = TelemIngestInputSchema.safeParse(payload);
        expect(parsed.success).toBe(true);
    });

    it('refuses contract call inputs to protect user privacy', () => {
        const payloadWithInputs = {
            sessionId: 'sess-12345',
            events: [
                {
                    type: 'call',
                    key: 'identity.ticket_issue',
                    outcome: 'ok',
                    // Disallowed input payload
                    password: 'super-secret-password',
                },
            ],
        };

        const parsed = TelemIngestInputSchema.safeParse(payloadWithInputs);
        expect(parsed.success).toBe(false);
    });

    it('bounds batch sizes to a maximum of 100 events', () => {
        const tooManyEvents = Array.from({ length: 101 }, (_, i) => ({
            type: 'log' as const,
            message: `Event ${i}`,
        }));

        const result = TelemIngestInputSchema.safeParse({
            sessionId: 'sess-123',
            events: tooManyEvents,
        });

        expect(result.success).toBe(false);
    });
});

describe('per-site configuration and sampling', () => {
    it('defaults to errors and boot always, calls sampled at 10%, debug off', () => {
        const config = resolveTelemConfig(null);

        expect(config.enabled).toBe(true);
        expect(config.minLevel).toBe('info');
        expect(config.sampleRates.error).toBe(1.0);
        expect(config.sampleRates.boot).toBe(1.0);
        expect(config.sampleRates.call).toBe(0.1);

        // Debug is dropped by default
        expect(shouldKeepEvent('log', 'debug', config)).toBe(false);
        // Info is kept
        expect(shouldKeepEvent('log', 'info', config)).toBe(true);
        // Errors are always kept
        expect(shouldKeepEvent('error', 'error', config)).toBe(true);
        expect(shouldKeepEvent('log', 'error', config)).toBe(true);
        // Boot is always kept
        expect(shouldKeepEvent('boot', 'info', config)).toBe(true);
    });

    it('honors site.policy configuration', () => {
        const site = {
            policy: {
                'telem.level': 'warn',
                'telem.sample.calls': '0.5',
            },
        };
        const config = resolveTelemConfig(site);

        expect(config.minLevel).toBe('warn');
        expect(config.sampleRates.call).toBe(0.5);

        // Info is below warn, so dropped
        expect(shouldKeepEvent('log', 'info', config)).toBe(false);
        // Warn is kept
        expect(shouldKeepEvent('log', 'warn', config)).toBe(true);
        // Call sampled at 0.5
        expect(shouldKeepEvent('call', 'info', config, () => 0.2)).toBe(true);
        expect(shouldKeepEvent('call', 'info', config, () => 0.8)).toBe(false);
        // Error always kept even if level config is warn
        expect(shouldKeepEvent('error', 'error', config, () => 0.99)).toBe(true);
    });

    it('can disable telemetry per site', () => {
        const site = {
            policy: {
                'telem.disabled': 'true',
            },
        };
        const config = resolveTelemConfig(site);
        expect(config.enabled).toBe(false);
        expect(shouldKeepEvent('log', 'info', config)).toBe(false);
        expect(shouldKeepEvent('error', 'error', config)).toBe(false);
    });
});

describe('rate limiting anonymous ingest', () => {
    it('throttles sessions exceeding batch rate limit', () => {
        const limiter = new TelemRateLimiter({
            maxBatchesPerSessionPerMinute: 3,
            maxEventsPerSessionPerMinute: 100,
        });

        expect(limiter.allow('sess-1', 'example.com', 5)).toBe(true);
        expect(limiter.allow('sess-1', 'example.com', 5)).toBe(true);
        expect(limiter.allow('sess-1', 'example.com', 5)).toBe(true);
        // Exceeds batch limit
        expect(limiter.allow('sess-1', 'example.com', 5)).toBe(false);
        // Different session is allowed
        expect(limiter.allow('sess-2', 'example.com', 5)).toBe(true);
    });

    it('throttles sessions exceeding event volume limit', () => {
        const limiter = new TelemRateLimiter({
            maxBatchesPerSessionPerMinute: 10,
            maxEventsPerSessionPerMinute: 50,
        });

        expect(limiter.allow('sess-1', 'example.com', 40)).toBe(true);
        // Adding 20 exceeds limit of 50
        expect(limiter.allow('sess-1', 'example.com', 20)).toBe(false);
    });
});

describe('file sink and database downtime resilience', () => {
    let tmpDir: string;
    let logFilePath: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telem-test-'));
        logFilePath = path.join(tmpDir, 'telem.ndjson');
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes ndjson lines to file and queries them back', async () => {
        const fileSink = new FileSink({ filePath: logFilePath });
        const record: TelemRecord = {
            id: 'rec-1',
            sessionId: 'sess-abc',
            site: 'example.com',
            source: 'browser',
            type: 'boot',
            level: 'info',
            timestamp: new Date(),
            details: { partId: 'main' },
        };

        await fileSink.write(record);
        await fileSink.flush();

        expect(fs.existsSync(logFilePath)).toBe(true);
        const content = fs.readFileSync(logFilePath, 'utf8');
        expect(content).toContain('"sessionId":"sess-abc"');
        expect(content).toContain('"partId":"main"');

        const queryResult = await fileSink.query({ sessionId: 'sess-abc', limit: 10 });
        expect(queryResult.total).toBe(1);
        expect(queryResult.events[0]?.id).toBe('rec-1');

        await fileSink.close();
    });

    it('composite sink preserves file write even when database is down/throwing', async () => {
        const fileSink = new FileSink({ filePath: logFilePath });

        // Broken collection sink simulating Mongo connection failure
        const brokenCollectionSink = new CollectionSink({ db: null });
        // Monkey-patch collection getter to simulate mongo error
        brokenCollectionSink.writeBatch = async () => {
            throw new Error('MongoServerSelectionError: connection refused');
        };

        const composite = new CompositeSink(fileSink, brokenCollectionSink);
        const record: TelemRecord = {
            id: 'rec-2',
            sessionId: 'sess-offline',
            site: 'example.com',
            source: 'cdn',
            type: 'request',
            level: 'warn',
            timestamp: new Date(),
            details: { status: 404, path: '/missing' },
        };

        // Write batch should not throw
        await composite.write(record);
        await composite.flush();

        // File sink still captured the log!
        const fileContent = fs.readFileSync(logFilePath, 'utf8');
        expect(fileContent).toContain('"sessionId":"sess-offline"');
        expect(fileContent).toContain('"status":404');

        // Query falls back to file when collection is down
        const queryResult = await composite.query({ sessionId: 'sess-offline', limit: 10 });
        expect(queryResult.total).toBe(1);
        expect(queryResult.events[0]?.sessionId).toBe('sess-offline');

        await composite.close();
    });
});

describe('request logging in CDN and API', () => {
    class MemorySink implements TelemSink {
        public records: RequestLogParams[] = [];
        write(): void {}
        writeBatch(): void {}
        recordRequest(params: RequestLogParams): void {
            this.records.push(params);
        }
    }

    const createMockReqRes = (url: string, headers: Record<string, string> = {}, method: string = 'GET') => {
        const socket = new Socket();
        const req = new IncomingMessage(socket);
        req.url = url;
        req.method = method;
        req.headers = { host: 'test.local', ...headers };

        const res = new ServerResponse(req);
        // Intercept writeHead and end to emit finish
        const origEnd = res.end.bind(res);
        res.end = function (...args: unknown[]) {
            const ret = origEnd(...(args as Parameters<typeof origEnd>));
            res.emit('finish');
            return ret;
        } as typeof res.end;

        return { req, res };
    };

    it('CDN service logs requests on finish with method, host, path, status, and duration', async () => {
        const sink = new MemorySink();
        const cdn = new CdnService({ port: 0, telem: sink });

        const { req, res } = createMockReqRes('/some/path', { 'x-session-id': 'sess-cdn-1' });

        await cdn.handle(req, res);

        expect(sink.records.length).toBe(1);
        expect(sink.records[0]).toMatchObject({
            source: 'cdn',
            host: 'test.local',
            method: 'GET',
            path: '/some/path',
            status: 404, // No site configured for test.local
            sessionId: 'sess-cdn-1',
        });
        expect(sink.records[0]?.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('API service logs requests on finish with method, host, path, status, and duration', async () => {
        const sink = new MemorySink();
        const api = new ApiService({ port: 0, telem: sink });

        const { req, res } = createMockReqRes('/api/users/whoami', { 'x-session-id': 'sess-api-1' });

        await api.handle(req, res);

        expect(sink.records.length).toBe(1);
        expect(sink.records[0]).toMatchObject({
            source: 'api',
            host: 'test.local',
            method: 'GET',
            path: '/api/users/whoami',
            status: 404, // No site configured for test.local
            sessionId: 'sess-api-1',
        });
        expect(sink.records[0]?.durationMs).toBeGreaterThanOrEqual(0);
    });
});

describe('TelemService ingest tool execution', () => {
    class MemorySink implements TelemSink {
        public saved: TelemRecord[] = [];
        write(): void {}
        async writeBatch(records: readonly TelemRecord[]): Promise<void> {
            this.saved.push(...records);
        }
        recordRequest(): void {}
    }

    it('ingests events, applies privacy rules and returns counts', async () => {
        const sink = new MemorySink();
        const service = new TelemService({ sink });

        const mockContext = {
            call: async (tool: string) => tool === 'cdn.resolve_site' ? { policy: { 'telem.sample.calls': '1.0' } } : null,
        } as unknown as Parameters<typeof service.ingest>[1];

        const result = await service.ingest({
            sessionId: 'sess-tool-test',
            host: 'test.local',
            events: [
                {
                    type: 'log',
                    level: 'info',
                    message: 'User logged in',
                },
                {
                    type: 'call',
                    key: 'catalog.publish',
                    durationMs: 30,
                    outcome: 'ok',
                },
                {
                    type: 'log',
                    level: 'debug', // default minLevel is info, so debug dropped
                    message: 'Verbose debug detail',
                },
            ],
        }, mockContext);

        expect(result.accepted).toBe(2);
        expect(result.dropped).toBe(1);
        expect(sink.saved.length).toBe(2);
        expect(sink.saved[0]?.sessionId).toBe('sess-tool-test');
        expect(sink.saved[0]?.type).toBe('log');
        expect(sink.saved[1]?.type).toBe('call');
        expect(sink.saved[1]?.details['key']).toBe('catalog.publish');
    });
});
