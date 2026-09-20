import type { Command } from 'commander';

/**
 * Maps the JSON Schema `_describe` carries into Commander options, and the raw option bag back
 * into a call's input.
 *
 * The sibling `ZodToCliMapper` does the same job for the CLI's own built-in commands, which hold
 * real zod objects. This one exists because a discovered api's surface arrives as *data*, and the
 * obvious shortcut is not available: `json-schema-to-zod` (already a dependency, used by
 * `generateClient`) emits zod **source text** for a file to be compiled, so using it here would
 * mean `eval`ing code derived from an HTTP response -- remote code execution dressed as
 * convenience. Reading the schema directly is both safer and less machinery.
 *
 * Option naming matches ZodToCliMapper's: nested objects flatten to dot notation (`--user.email`),
 * so a built-in command and a discovered one look the same on the command line.
 */

interface JsonSchema {
    type?: string | readonly string[];
    description?: string;
    properties?: Record<string, JsonSchema>;
    required?: readonly string[];
    items?: JsonSchema;
    enum?: readonly unknown[];
    anyOf?: readonly JsonSchema[];
    oneOf?: readonly JsonSchema[];
    additionalProperties?: boolean | JsonSchema;
    default?: unknown;
}

/** The single type a value carries, with `null` (from `.nullable()`) ignored. */
function primaryType(schema: JsonSchema): string | undefined {
    const raw = schema.type;
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) return raw.find((t) => t !== 'null');
    // `.nullable()` and unions render as anyOf/oneOf; the first branch that names a type is the
    // one worth showing on the command line. A genuine multi-type union degrades to a string
    // option, which the server still validates.
    for (const branch of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
        const found = primaryType(branch);
        if (found !== undefined && found !== 'null') return found;
    }
    return undefined;
}

/** An object with declared fields is walked; a free-form record is not (its keys are unknowable). */
function hasNamedFields(schema: JsonSchema): boolean {
    return schema.properties !== undefined && Object.keys(schema.properties).length > 0;
}

function describe(schema: JsonSchema, required: boolean): string {
    const parts: string[] = [];
    if (typeof schema.description === 'string') parts.push(schema.description);
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        parts.push(`one of: ${schema.enum.map((v) => String(v)).join(', ')}`);
    }
    if (required) parts.push('(required)');
    return parts.join(' ');
}

export class JsonSchemaToCli {
    /**
     * Declares one option per input field. Required fields are *described* as required rather than
     * declared with `requiredOption`, so `--help` still renders for a command whose arguments you
     * are trying to look up. The missing-field error comes from validation below, or from the
     * server, which owns the real schema either way.
     */
    public static applyOptions(command: Command, schema: JsonSchema, prefix = ''): void {
        if (!hasNamedFields(schema)) return;
        const required = new Set(schema.required ?? []);

        for (const [key, field] of Object.entries(schema.properties ?? {})) {
            const name = prefix === '' ? key : `${prefix}.${key}`;
            const isRequired = prefix === '' && required.has(key);
            const type = primaryType(field);

            if (type === 'object' && hasNamedFields(field)) {
                this.applyOptions(command, field, name);
                continue;
            }

            const help = describe(field, isRequired);

            if (type === 'boolean') {
                command.option(`--${name}`, help);
            } else if (type === 'array') {
                command.option(`--${name} <values...>`, help);
            } else if (type === 'object') {
                // A record or an unknown object: its keys cannot be declared ahead of time, so it
                // is taken as JSON. `--query '{"status":"active"}'` is how a CRUD find gets one.
                command.option(`--${name} <json>`, help === '' ? 'JSON object' : `${help} (JSON)`);
            } else {
                command.option(`--${name} <value>`, help);
            }
        }
    }

    /**
     * Rebuilds the nested input from the flat option bag, coercing each value by its declared type.
     *
     * Commander hands back strings for everything but flags, and the gateway forwards the body to
     * a contract whose zod schema is strict -- so `--port 3223` has to arrive as a number, not
     * `"3223"`, or the call fails validation at the far end for a reason that reads like a bug.
     */
    public static parseOptions(raw: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
        const out: Record<string, unknown> = {};

        for (const [flatKey, rawValue] of Object.entries(raw)) {
            if (rawValue === undefined) continue;

            const parts = flatKey.split('.');
            const field = this.fieldAt(schema, parts);
            if (field === undefined) continue;

            let cursor = out;
            for (const part of parts.slice(0, -1)) {
                if (typeof cursor[part] !== 'object' || cursor[part] === null) cursor[part] = {};
                cursor = cursor[part] as Record<string, unknown>;
            }
            cursor[parts[parts.length - 1]!] = this.coerce(rawValue, field);
        }

        return out;
    }

    /** Which fields a caller left out. Reported before the request, naming all of them at once. */
    public static missingRequired(input: Record<string, unknown>, schema: JsonSchema): string[] {
        return (schema.required ?? []).filter((key) => input[key] === undefined);
    }

    private static fieldAt(schema: JsonSchema, path: readonly string[]): JsonSchema | undefined {
        let current: JsonSchema | undefined = schema;
        for (const part of path) {
            if (current?.properties === undefined) return undefined;
            current = current.properties[part];
        }
        return current;
    }

    private static coerce(value: unknown, schema: JsonSchema): unknown {
        const type = primaryType(schema);

        if (Array.isArray(value)) {
            const items = schema.items;
            return items === undefined ? value : value.map((entry) => this.coerce(entry, items));
        }

        if (typeof value !== 'string') return value;

        switch (type) {
            case 'number':
            case 'integer': {
                const parsed = Number(value);
                // A non-numeric string is passed through rather than silently becoming NaN: the
                // server's own validator produces a better message than anything guessable here.
                return Number.isNaN(parsed) ? value : parsed;
            }
            case 'boolean':
                return value !== 'false' && value !== '0';
            case 'object':
            case 'array':
                try {
                    return JSON.parse(value);
                } catch {
                    return value;
                }
            default:
                return value;
        }
    }
}
