/**
 * **Arguments, parsed against the contract's own input schema.**
 *
 * No `commander`, and that is the point rather than a preference. mesh's generated CLI took it, and
 * commander owns `--version` on the program — so any contract with a `version` input printed the
 * CLI's version and **exited 0 having done nothing**. That is roadmap **F7**, it hits
 * `builder.build_start`, `catalog.publish` and all eight `partVersion` commands, and the failure
 * mode is a command that looks like it worked.
 *
 * A parser that owns no flag names cannot have that bug. Every flag here comes from the schema the
 * site published; this file reserves nothing.
 *
 * See `spec/cli.md` §1 and §6.
 */

import { CliError } from './descriptor.js';

/** The subset of JSON Schema a contract input actually uses. */
interface Schema {
    readonly type?: string;
    readonly properties?: Record<string, Schema & { readonly description?: string }>;
    readonly required?: readonly string[];
    readonly items?: Schema;
    readonly enum?: readonly unknown[];
    readonly description?: string;
}

/**
 * `--name value`, `--flag`, and `--` for the rest.
 *
 * A boolean takes no value, which is the one place a parser must know a type before it reads the
 * next token — so the schema is consulted rather than guessed at. Without it, `--dry-run find` reads
 * `find` as the value of `--dry-run` and then complains that no command was given.
 */
export function parseArgs(argv: readonly string[], schema: Schema | undefined): Record<string, unknown> {
    const properties = schema?.properties ?? {};
    const out: Record<string, unknown> = {};

    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i] ?? '';
        if (!token.startsWith('--')) continue;

        const [flag, inline] = token.slice(2).split('=', 2);
        const name = camel(flag ?? '');
        const property = properties[name];

        if (property?.type === 'boolean') {
            out[name] = inline === undefined ? true : inline === 'true';
            continue;
        }

        const raw = inline ?? argv[i + 1];
        if (inline === undefined) i += 1;
        if (raw === undefined) throw new CliError(`--${flag ?? ''} needs a value.`);

        out[name] = coerce(raw, property);
    }

    return out;
}

/**
 * `--org-slug` and `--orgSlug` mean the same thing.
 *
 * Schemas are written in the codebase's own casing and flags are typed by people, and insisting the
 * two match is a rule nobody remembers at a terminal.
 */
const camel = (flag: string): string => flag.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

/**
 * A string becomes what the schema says it is.
 *
 * An unknown property is left a string rather than guessed at — the api validates the input and its
 * error names the field, which is a better answer than a CLI inventing a shape and sending it.
 */
function coerce(raw: string, property: Schema | undefined): unknown {
    switch (property?.type) {
        case 'number':
        case 'integer': {
            const value = Number(raw);
            if (Number.isNaN(value)) throw new CliError(`Expected a number, got "${raw}".`);
            return value;
        }
        case 'boolean':
            return raw === 'true' || raw === '1';
        case 'array':
            // Comma-separated, because a shell that has to quote a JSON array is a shell nobody uses.
            return raw.split(',').map((part) => coerce(part.trim(), property.items));
        case 'object':
            try {
                return JSON.parse(raw);
            } catch {
                throw new CliError(`Expected JSON for this field, got "${raw}".`);
            }
        default:
            return raw;
    }
}

/**
 * What the schema says is required and the caller did not give.
 *
 * Checked here **as well as** on the server, and the duplication is deliberate: a round trip to be
 * told a field is missing is slower and its message is about a JSON body rather than about the flag
 * a person typed. The server's check is the one that matters; this one is the one that helps.
 */
export function missingRequired(input: Record<string, unknown>, schema: Schema | undefined): readonly string[] {
    return (schema?.required ?? []).filter((name) => input[name] === undefined);
}

/** `--org-slug`, from `orgSlug`. What a person types, derived from what the schema declares. */
export const flagFor = (name: string): string =>
    `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/** One line per field: the flag, whether it is required, and what it is for. */
export function describeInput(schema: Schema | undefined): readonly string[] {
    const properties = schema?.properties ?? {};
    const required = new Set(schema?.required ?? []);

    return Object.entries(properties).map(([name, property]) => {
        const type = property.type ?? 'string';
        const mark = required.has(name) ? ' (required)' : '';
        const about = property.description === undefined ? '' : `  ${property.description}`;
        return `    ${flagFor(name)} <${type}>${mark}${about}`;
    });
}

export type { Schema };
