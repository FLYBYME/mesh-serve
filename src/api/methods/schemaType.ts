/**
 * A JSON Schema's TypeScript type, as text: the type `z.infer` (side `output`) or `z.input` (side
 * `input`) gives the zod that `json-schema-to-zod` renders from the same schema. Written out in the
 * generated client so the compiler reads a declared type instead of inferring one from each zod
 * expression -- 1,460 inferences made api.surfdns.net's client cost 19 s and 600 MB to check, and
 * an editor could not keep up (10-23). test/unit/api/schemaType.test.ts holds it to zod's own.
 */
export type Side = 'output' | 'input';

type Schema = Record<string, unknown>;

function isSchema(value: unknown): value is Schema {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function literal(value: unknown): string {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return JSON.stringify(value);
    }

    return 'any';
}

function union(parts: readonly string[]): string {
    if (parts.length === 0) return 'never';
    if (parts.includes('any')) return 'any';

    const unique = [...new Set(parts)];
    return unique.length === 1 ? (unique[0] ?? 'never') : unique.map((p) => `(${p})`).join(' | ');
}

function intersection(parts: readonly string[]): string {
    if (parts.length === 0) return 'unknown';

    return parts.length === 1 ? (parts[0] ?? 'unknown') : parts.map((p) => `(${p})`).join(' & ');
}

/** Whether zod's object typing treats the field as one that may be left out: its type admits undefined. */
function admitsUndefined(type: string): boolean {
    return type === 'any' || type === 'unknown' || type.endsWith(' | undefined');
}

function hasDefault(schema: unknown): boolean {
    return isSchema(schema) && schema.default !== undefined;
}

function objectType(schema: Schema, side: Side): string {
    const parts: string[] = [];
    const extra = schema.additionalProperties;
    const properties = schema.properties;

    if (isSchema(properties)) {
        const required = Array.isArray(schema.required) ? schema.required : [];
        const fields = Object.entries(properties).map(([key, field]) => {
            const isRequired = Array.isArray(schema.required)
                ? required.includes(key)
                : isSchema(field) && field.required === true;
            const optional = !hasDefault(field) && !isRequired;

            let type = typeOf(field, side);
            if (optional && !admitsUndefined(type)) type = `${type} | undefined`;

            return `${JSON.stringify(key)}${admitsUndefined(type) ? '?' : ''}: ${type}`;
        });
        parts.push(fields.length === 0 ? '{}' : `{ ${fields.join('; ')} }`);

        if (extra !== undefined && extra !== false) {
            parts.push(`{ [key: string]: ${typeOf(extra, side)} }`);
        }
    } else {
        parts.push(`Record<string, ${extra === undefined ? 'any' : typeOf(extra, side)}>`);
    }

    for (const combinator of ['anyOf', 'oneOf'] as const) {
        const options = schema[combinator];
        if (Array.isArray(options)) parts.push(union(options.map((o) => typeOf(asObject(o), side))));
    }
    if (Array.isArray(schema.allOf)) {
        parts.push(intersection(schema.allOf.map((o) => typeOf(asObject(o), side))));
    }

    return intersection(parts);
}

/** A member of an object's combinator with fields but no type is read as an object, as json-schema-to-zod does. */
function asObject(option: unknown): unknown {
    if (isSchema(option) && option.type === undefined
        && (option.properties !== undefined || option.additionalProperties !== undefined || option.patternProperties !== undefined)) {
        return { ...option, type: 'object' };
    }

    return option;
}

function arrayType(schema: Schema, side: Side): string {
    const items = schema.items;
    if (Array.isArray(items)) return `[${items.map((i) => typeOf(i, side)).join(', ')}]`;
    if (items === undefined) return 'any[]';

    return `Array<${typeOf(items, side)}>`;
}

function primitive(type: unknown): string | undefined {
    switch (type) {
        case 'string': return 'string';
        case 'number':
        case 'integer': return 'number';
        case 'boolean': return 'boolean';
        case 'null': return 'null';
        default: return undefined;
    }
}

/** The type before the schema's own `default` and `readOnly`. */
function bareType(schema: Schema, side: Side): string {
    if (schema.nullable === true) {
        const { nullable: _nullable, ...rest } = schema;
        return union([bareType(rest, side), 'null']);
    }
    if (schema.type === 'object') return objectType(schema, side);
    if (schema.type === 'array') return arrayType(schema, side);
    if (Array.isArray(schema.anyOf)) return union(schema.anyOf.map((o) => typeOf(o, side)));
    if (Array.isArray(schema.allOf)) return intersection(schema.allOf.map((o) => typeOf(o, side)));
    if (Array.isArray(schema.oneOf)) return union(schema.oneOf.map((o) => typeOf(o, side)));
    if (schema.not !== undefined) return 'any';
    if (Array.isArray(schema.enum)) return union(schema.enum.map(literal));
    if (schema.const !== undefined) return literal(schema.const);
    if (Array.isArray(schema.type)) return union(schema.type.map((t) => bareType({ ...schema, type: t }, side)));

    return primitive(schema.type) ?? 'any';
}

export function typeOf(schema: unknown, side: Side): string {
    if (typeof schema === 'boolean') return schema ? 'any' : 'never';
    if (!isSchema(schema)) return 'any';

    let type = bareType(schema, side);
    if (schema.default !== undefined && side === 'input' && !admitsUndefined(type)) type = `${type} | undefined`;
    if (schema.readOnly === true) type = `Readonly<${type}>`;

    return type;
}

/** One field of an object schema, as the zod type its shape declares it by: `z.ZodType<out, def, in>`. */
function fieldZodType(schema: Schema, key: string, field: unknown): string {
    const isRequired = Array.isArray(schema.required) ? schema.required.includes(key) : isSchema(field) && field.required === true;
    const optional = !hasDefault(field) && !isRequired;
    const out = typeOf(field, 'output');
    const inn = typeOf(field, 'input');

    const withUndefined = (t: string): string => (optional && !admitsUndefined(t) ? `${t} | undefined` : t);

    return `z.ZodType<${withUndefined(out)}, z.ZodTypeDef, ${withUndefined(inn)}>`;
}

/**
 * The declared type of the generated schema constant: an object keeps `z.ZodObject` with its shape
 * (forms `.extend` one), an array of one kind `z.ZodArray`, anything else `z.ZodType`. The output and
 * input types are named, never derived from the shape.
 */
export function zodTypeOf(schema: unknown, outputName: string, inputName: string): string {
    const plain = isSchema(schema) && schema.default === undefined && schema.readOnly !== true && schema.nullable !== true;

    if (plain && schema.type === 'object' && isSchema(schema.properties)
        && schema.anyOf === undefined && schema.oneOf === undefined && schema.allOf === undefined && schema.patternProperties === undefined
        && (schema.additionalProperties === undefined || schema.additionalProperties === false)) {
        const properties = schema.properties;
        const shape = Object.keys(properties).map((key) => `${JSON.stringify(key)}: ${fieldZodType(schema, key, properties[key])}`);
        const unknownKeys = schema.additionalProperties === false ? "'strict'" : "'strip'";

        return `z.ZodObject<{ ${shape.join('; ')} }, ${unknownKeys}, z.ZodTypeAny, ${outputName}, ${inputName}>`;
    }

    if (plain && schema.type === 'array' && isSchema(schema.items)) {
        return `z.ZodArray<z.ZodType<${typeOf(schema.items, 'output')}, z.ZodTypeDef, ${typeOf(schema.items, 'input')}>>`;
    }

    return `z.ZodType<${outputName}, z.ZodTypeDef, ${inputName}>`;
}
