/**
 * The activity log -- pure. Every call through the api that changes something, and every one the
 * api refused, as one row: who (a person, or which agent's token), in which organization, what
 * (the contract and a redacted summary of its input), and how it came out. The owner, 2026-10-01:
 * "some sort of oplog for things like granting access" -- and an agent acting for someone by email
 * has to be answerable to "what did it do as them, and when".
 *
 * Reads are not recorded (they would bury the changes); a refused read is, because a refusal is a
 * signal ("security through knowledge"). Nothing secret is ever written: inputs are summarized with
 * every secret-looking field replaced, and capped in size.
 */

export type ActivityOutcome = 'ok' | 'refused' | 'failed' | 'held';

/** What is recorded: anything that changes state, and anything refused. */
export function shouldRecord(contract: { readonly destructive?: boolean }, outcome: ActivityOutcome): boolean {
    return contract.destructive === true || outcome === 'refused';
}

/** How a call came out, from the status it ended with. */
export function outcomeOf(status: number): ActivityOutcome {
    if (status === 202) return 'held';
    if (status === 401 || status === 403) return 'refused';
    if (status >= 400) return 'failed';
    return 'ok';
}

/** A field whose value is never written down, whatever it holds. */
const SECRET = /pass(word|wd|phrase)?|secret|token|api_?key|private_?key|credential|hash|authorization|cookie|seal/i;
const MAX_STRING = 200;
const MAX_ITEMS = 20;
const MAX_DEPTH = 4;
export const MAX_SUMMARY = 2000;

function summarize(value: unknown, depth: number): unknown {
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(${value.length})` : value;
    if (value instanceof Date) return value.toISOString();
    if (depth >= MAX_DEPTH) return '…';
    if (Array.isArray(value)) {
        const items = value.slice(0, MAX_ITEMS).map((v) => summarize(v, depth + 1));
        return value.length > MAX_ITEMS ? [...items, `…(${value.length} items)`] : items;
    }
    if (typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = SECRET.test(k) ? '[redacted]' : summarize(v, depth + 1);
        return out;
    }
    return String(value);
}

/** The input, as it is written to the log: secrets replaced, long values cut, at most MAX_SUMMARY characters. */
export function summarizeInput(input: unknown): string {
    if (input === undefined) return '';
    const text = JSON.stringify(summarize(input, 0)) ?? '';
    return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY)}…` : text;
}

/** How long a row is kept: the database's own expiry removes it after this. */
export const ACTIVITY_RETENTION_DAYS = 90;
