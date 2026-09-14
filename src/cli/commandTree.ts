import { Command } from 'commander';

import type { DescribedCall, ExposureDescriptor } from './describe.js';
import type { Session } from './session.js';
import type { Client } from './client.js';

interface JsonSchemaObject {
    readonly properties?: Record<string, { readonly description?: string }>;
    readonly required?: readonly string[];
}

function isJsonSchemaObject(schema: unknown): schema is JsonSchemaObject {
    return typeof schema === 'object' && schema !== null;
}

/**
 * Builds a fresh commander program from a descriptor every time it's invoked, one domain command
 * per group and one action subcommand per call, with flags read off each call's JSON-schema input.
 * Rebuilt per-invocation rather than kept around: it's cheap, and it avoids commander state (parsed
 * option values, subcommand registration) leaking between unrelated calls in a long-lived REPL.
 */
export function buildProgram(session: Session, descriptor: ExposureDescriptor, client: Client, onResult: (call: DescribedCall, result: unknown) => void): Command {
    const program = new Command();
    program.name('mesh-serve').exitOverride();

    const byDomain = new Map<string, DescribedCall[]>();
    for (const call of descriptor.calls) {
        const list = byDomain.get(call.domain) ?? [];
        list.push(call);
        byDomain.set(call.domain, list);
    }

    for (const [domain, calls] of byDomain) {
        const domainCmd = program.command(domain).description(`${domain} calls`).exitOverride();

        for (const call of calls) {
            const actionCmd = domainCmd.command(call.action).description(call.description).exitOverride();

            const schema = call.input;
            if (isJsonSchemaObject(schema) && schema.properties !== undefined) {
                for (const [field, fieldSchema] of Object.entries(schema.properties)) {
                    const required = schema.required?.includes(field) ?? false;
                    const flag = required ? `--${field} <value>` : `--${field} [value]`;
                    actionCmd.option(flag, fieldSchema.description ?? '');
                }
            }

            actionCmd.action(async (opts: Record<string, unknown>) => {
                const result = await client.call(session, call, opts);
                onResult(call, result.body);
            });
        }
    }

    return program;
}
