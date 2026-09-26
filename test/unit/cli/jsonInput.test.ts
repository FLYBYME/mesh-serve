import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const sent: Array<{ key: string; input: Record<string, unknown> }> = [];
vi.mock('../../../src/cli/core/apiClient.js', () => ({
    ApiError: class ApiError extends Error {},
    callApi: async (_url: string, call: { key: string }, input: Record<string, unknown>) => {
        sent.push({ key: call.key, input });
        return { ok: true };
    },
}));

const { registerDiscoveredCommands } = await import('../../../src/cli/core/dynamicCommands.js');
import type { DescribedCall } from '../../../src/api/methods/descriptor.js';
import type { Session } from '../../../src/cli/core/session.js';

const call = (key: string, input: unknown): DescribedCall => ({
    key, domain: key.slice(0, key.lastIndexOf('.')), action: key.slice(key.lastIndexOf('.') + 1),
    description: key, method: 'POST', path: `/${key}`, gate: 'public', input, output: {},
});

// dns.record_create's shape: a union at the top, fields differing per record type -- before, a
// command with no options at all.
const recordCreate = call('dns.record_create', {
    anyOf: [
        { type: 'object', properties: { type: { const: 'A' }, name: { type: 'string' }, address: { type: 'string' } } },
        { type: 'object', properties: { type: { const: 'MX' }, name: { type: 'string' }, exchange: { type: 'string' } } },
    ],
});
const k8sExec = call('k8s.exec', {
    type: 'object',
    properties: { pod: { type: 'string' }, command: { type: 'array', items: { type: 'string' } } },
    required: ['pod', 'command'],
});

const session: Session = {
    apiUrl: 'http://api.test', token: 't',
    descriptor: { host: 'api.test', base: '/api', shapeHash: 'h', exposure: 'e', calls: [recordCreate, k8sExec], fetchedAt: 0 },
};

async function run(...args: string[]): Promise<void> {
    const program = new Command().exitOverride();
    registerDiscoveredCommands(program, session);
    await program.parseAsync(['node', 'mesh-serve', ...args]);
}

describe('--json: the whole input as one object', () => {
    let errors: string[];
    beforeEach(() => {
        sent.length = 0;
        errors = [];
        process.exitCode = undefined;
        vi.spyOn(console, 'error').mockImplementation((m: unknown) => { errors.push(String(m)); });
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
    });
    afterEach(() => {
        vi.restoreAllMocks();
        process.exitCode = undefined;
    });

    it('carries a union-shaped input intact -- a DNS record could not be created from the CLI before', async () => {
        await run('dns.record_create', '--json', '{"type":"MX","name":"@","exchange":"mail.surfdns.net"}');
        expect(sent).toEqual([{ key: 'dns.record_create', input: { type: 'MX', name: '@', exchange: 'mail.surfdns.net' } }]);
    });

    it('carries values starting with "-" that commander would read as options', async () => {
        await run('k8s.exec', '--json', '{"pod":"p","command":["sh","-c","longhorn snapshot --help"]}');
        expect(sent[0]?.input).toEqual({ pod: 'p', command: ['sh', '-c', 'longhorn snapshot --help'] });
    });

    it('refuses --json together with another flag, and sends nothing', async () => {
        await run('k8s.exec', '--json', '{"pod":"p","command":["id"]}', '--pod', 'q');
        expect(sent).toEqual([]);
        expect(process.exitCode).toBe(1);
        expect(errors.join(' ')).toMatch(/--pod/);
    });

    it('refuses invalid JSON, and JSON that is not an object, before any request', async () => {
        await run('k8s.exec', '--json', '{pod: p}');
        await run('k8s.exec', '--json', '["pod"]');
        expect(sent).toEqual([]);
        expect(errors.join(' ')).toMatch(/not valid JSON/);
        expect(errors.join(' ')).toMatch(/must be a JSON object/);
    });

    it('leaves ordinary flags working as before', async () => {
        await run('k8s.exec', '--pod', 'p', '--command', 'id');
        expect(sent).toEqual([{ key: 'k8s.exec', input: { pod: 'p', command: ['id'] } }]);
    });
});
