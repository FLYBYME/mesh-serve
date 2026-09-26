import { LogLevel } from '@flybyme/mesh';

/**
 * This node's recent log lines, kept in memory so an operator can read them through the api --
 * `serve.node.logs`. Diagnosing the surf stall (2026-09-26) meant `journalctl` over SSH on each box;
 * the journal stays the record of truth, this is the window onto its recent end.
 *
 * Bounded: the newest LOG_BUFFER_LINES lines, oldest dropped first. Not persisted -- a restart
 * starts it empty, and the journal still has everything before.
 */
export const LOG_BUFFER_LINES = 5000;

const lines: string[] = [];

const LEVEL_NAMES: Record<number, string> = {
    [LogLevel.DEBUG]: 'debug', [LogLevel.INFO]: 'info', [LogLevel.WARN]: 'warn', [LogLevel.ERROR]: 'error',
};

function render(arg: unknown): string {
    if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
    if (typeof arg === 'string') return arg;
    try {
        return JSON.stringify(arg);
    } catch {
        return String(arg);
    }
}

export function recordLog(level: LogLevel, formatted: string, args: readonly unknown[]): void {
    const extra = args.length > 0 ? ` ${args.map(render).join(' ')}` : '';
    lines.push(`${LEVEL_NAMES[level] ?? String(level)} ${formatted}${extra}`);
    if (lines.length > LOG_BUFFER_LINES) lines.splice(0, lines.length - LOG_BUFFER_LINES);
}

/**
 * The newest `count` lines, oldest first -- of those containing `grep`, when given. `grep` is a plain
 * substring, not a pattern: a regular expression from the outside is a way to hang the node.
 */
export function readLogs(count: number, grep?: string): { lines: string[]; matched: number } {
    const pool = grep === undefined || grep === '' ? lines : lines.filter((line) => line.includes(grep));
    return { lines: pool.slice(Math.max(0, pool.length - count)), matched: pool.length };
}

/** For tests only. */
export function clearLogs(): void {
    lines.length = 0;
}
