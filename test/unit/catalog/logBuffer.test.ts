import { afterEach, describe, expect, it } from 'vitest';
import { LogLevel } from '@flybyme/mesh';
import { clearLogs, LOG_BUFFER_LINES, readLogs, recordLog } from '../../../src/catalog/methods/logBuffer.js';

describe('the node log buffer behind serve.node.logs', () => {
    afterEach(() => clearLogs());

    it('keeps the newest lines, oldest first, with the level and any extra arguments', () => {
        recordLog(LogLevel.INFO, '[t] one', []);
        recordLog(LogLevel.WARN, '[t] two', [new Error('boom')]);
        const { lines, matched } = readLogs(10);
        expect(matched).toBe(2);
        expect(lines[0]).toBe('info [t] one');
        expect(lines[1]).toMatch(/^warn \[t\] two Error: boom/);
    });

    it('filters by plain text -- regex characters are just text', () => {
        recordLog(LogLevel.INFO, 'RPC Timeout calling a', []);
        recordLog(LogLevel.INFO, 'fine', []);
        recordLog(LogLevel.INFO, 'RPC Timeout calling b', []);
        expect(readLogs(1, 'RPC Timeout')).toEqual({ lines: ['info RPC Timeout calling b'], matched: 2 });
        expect(readLogs(10, '(.*)+$').matched).toBe(0);
    });

    it('is bounded: the oldest lines go first', () => {
        for (let i = 0; i < LOG_BUFFER_LINES + 10; i++) recordLog(LogLevel.INFO, `line ${i}`, []);
        const { lines, matched } = readLogs(LOG_BUFFER_LINES + 100);
        expect(matched).toBe(LOG_BUFFER_LINES);
        expect(lines[0]).toBe('info line 10');
    });
});
