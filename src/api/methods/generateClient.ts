import { jsonSchemaToZod } from 'json-schema-to-zod';

import { buildDescriptor, type DeclarationLookup, type ExposureDescriptor } from './descriptor.js';
import { typeOf, zodTypeOf } from './schemaType.js';
import type { Expose } from '../contracts/expose.contract.js';

/**
 * Renders the browser-safe, type-safe client mesh-web/mesh-serve's own CLI import from -- real zod,
 * not a JSON-Schema-derived approximation, and self-contained: no reference to mesh-serve anywhere
 * in the output. `jsonSchemaToZod` turns the JSON Schema `_describe` already computes back into real
 * zod *source text* (`z.object({...}).email()`, not just a bare shape) -- a freshly declared value in
 * the generated file, using whichever zod the consumer has installed, not a live reference into
 * mesh-serve's own (surfdns #15's actual failure mode: a *live* cross-package `z.infer` reference
 * degrading under version skew). Nothing here imports zod-to-json-schema's output as a *type*; only
 * the rendered zod source ships.
 */

function pascalCase(key: string): string {
    return key
        .split('.')
        .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
        .join('');
}

function lowerFirst(s: string): string {
    return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * A JS identifier from an arbitrary string -- `id` is a site's `application` field, which follows
 * the "org-slug/part-name" convention (part.contract.ts), so "acme/blog" must become a valid export
 * name (`acmeBlogApi`), not `acme/blogApi`, which is a syntax error, not merely a lint complaint.
 */
function camelIdentifier(raw: string): string {
    const parts = raw.split(/[^a-zA-Z0-9]+/).filter((p) => p.length > 0);
    if (parts.length === 0) return 'client';
    const [first, ...rest] = parts;
    const identifier = (first as string).charAt(0).toLowerCase() + (first as string).slice(1)
        + rest.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
    return /^[0-9]/.test(identifier) ? `_${identifier}` : identifier;
}

/** The name a generated client exports its api by: api.one-host.ca -> apiOneHostCaApi. */
export function apiExportName(id: string): string {
    return `${camelIdentifier(id)}Api`;
}

/**
 * One schema and its type. The schema is built inside a `/* @__PURE__ *\/` call, so a bundler drops
 * every one nothing reads at run time: the client's calls only name them in types. A bare
 * `z.object(...)` at the top level is a call the bundler cannot prove free of effects, so all of
 * them shipped -- the company site carried 1,400 schemas (about 1.5 MB) to use five (10-11).
 */
function schemaDeclaration(schemaName: string, typeName: string, requestName: string | undefined, schema: Record<string, unknown>): string {
    const inlined = inlineLocalRefs(schema);
    const expression = jsonSchemaToZod(inlined);

    // Its types written out, and the constant declared by them: the file is never checked
    // (@ts-nocheck), so the compiler reads these instead of inferring each zod expression.
    const lines = [`export type ${typeName} = ${typeOf(inlined, 'output')}`];
    if (requestName !== undefined) lines.push(`export type ${requestName} = ${typeOf(inlined, 'input')}`);
    lines.push(`export const ${schemaName}: ${zodTypeOf(inlined, typeName, requestName ?? typeName)} = /* @__PURE__ */ (() => ${expression})()`);

    return `${lines.join('\n')}\n`;
}

/** The value at a local JSON pointer (`#/properties/disk/properties/sizeGb`), or undefined. */
function resolvePointer(root: unknown, ref: string): unknown {
    if (!ref.startsWith('#/')) return undefined;

    let node = root;
    for (const raw of ref.slice(2).split('/')) {
        const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
        if (typeof node !== 'object' || node === null) return undefined;
        node = Reflect.get(node, key);
    }

    return node;
}

/**
 * The schema with every local `$ref` replaced by what it points at. zod-to-json-schema writes a
 * zod schema used twice as a `$ref` to its first use (`EnvironmentDiskSchema.extend(...)` inside
 * an array points at `disk`'s fields), and jsonSchemaToZod renders a `$ref` as `z.any()`: the
 * console's volumes came out as `sizeGb: any` (10-18). A pointer seen again on its own path is a
 * cycle and stays `$ref` (rendered `any`) rather than recursing forever.
 */
export function inlineLocalRefs(schema: Record<string, unknown>): Record<string, unknown> {
    const walk = (node: unknown, seen: readonly string[]): unknown => {
        if (Array.isArray(node)) return node.map((item) => walk(item, seen));
        if (typeof node !== 'object' || node === null) return node;

        const ref = Reflect.get(node, '$ref');
        if (typeof ref === 'string' && !seen.includes(ref)) {
            const target = resolvePointer(schema, ref);
            if (target !== undefined) {
                const { $ref: _ref, ...rest } = Object.fromEntries(Object.entries(node));
                const resolved = walk(target, [...seen, ref]);
                return typeof resolved === 'object' && resolved !== null && !Array.isArray(resolved)
                    ? { ...resolved, ...rest }
                    : resolved;
            }
        }

        return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, walk(value, seen)]));
    };

    const result = walk(schema, []);
    return typeof result === 'object' && result !== null && !Array.isArray(result)
        ? Object.fromEntries(Object.entries(result))
        : schema;
}

function isEmptyObjectSchema(schema: unknown): boolean {
    if (typeof schema !== 'object' || schema === null) return false;
    const s = schema as { type?: string; properties?: Record<string, unknown> };
    return s.type === 'object' && (s.properties === undefined || Object.keys(s.properties).length === 0);
}

/**
 * A described call's gate — `buildDescriptor`'s `gateOf`: the contract's own floor and the expose
 * row's role joined with `+`, `permission:<p>` for a permission, `public` for neither — as the
 * client's `Gate` literal. A permission is the most specific thing a caller must hold, so it wins;
 * otherwise the last role (the row's own, which `gateOf` appends after the contract's floor).
 *
 * Read from the descriptor rather than the expose rows so the same function renders a client on
 * the server (`serve.api.generateClient`) and on an operator's machine from the public
 * `/api/_describe` (`mesh-serve generate`) — one renderer, one output, wherever it runs.
 */
export function gateLiteral(gate: string): string {
    if (gate === 'public' || gate === '') return 'undefined';
    const parts = gate.split('+');
    const permission = parts.find((p) => p.startsWith('permission:'));
    if (permission !== undefined) return `{ kind: 'permission', permission: ${JSON.stringify(permission.slice('permission:'.length))} }`;
    const role = parts.at(-1);
    return role === undefined ? 'undefined' : `{ kind: 'role', role: ${JSON.stringify(role)} }`;
}

/** The server's entry: the rows it holds, joined against the live contracts, then rendered. */
export async function generateClient(id: string, host: string, rows: readonly Expose[], declare: DeclarationLookup): Promise<string> {
    return renderClient(id, buildDescriptor(host, rows, declare));
}

/**
 * The client for a described api — the whole of the rendering. Pure: a descriptor in, source text
 * out, so it runs wherever the descriptor is, including an operator's machine with no access to the
 * api's records (`mesh-serve generate`). A fix to what is rendered then takes effect with the
 * operator's installed mesh-serve, not after every node is upgraded.
 */
export function renderClient(id: string, descriptor: ExposureDescriptor): string {
    const schemas: string[] = [];
    const callEntries: string[] = [];

    for (const call of descriptor.calls) {
        const name = pascalCase(call.key);

        let inputType = 'void';
        // The call carries its input schema, and mesh-web checks every input with it before sending
        // (owner, 10-14: "the zod schema does not just provide types").
        let options = '';
        if (!isEmptyObjectSchema(call.input)) {
            const schemaName = `${lowerFirst(name)}InputSchema`;
            // `XInput` stays what it was — the parsed shape (`z.infer`), which the server sees.
            // A *caller* passes `XRequest`, the input side: a field with a default may be left out.
            // Typing the call with the parsed shape made every defaulted field required at every
            // call site (`domain.find` demanded `offset`, found by the company site's dashboard).
            schemas.push(schemaDeclaration(schemaName, `${name}Input`, `${name}Request`, call.input as Record<string, unknown>));
            inputType = `${name}Request`;
            options = `, { inputSchema: ${schemaName} }`;
        }

        const outputType = `${name}Output`;
        schemas.push(schemaDeclaration(`${lowerFirst(name)}OutputSchema`, outputType, undefined, call.output as Record<string, unknown>));

        const gate = gateLiteral(call.gate);
        const doc = [
            call.description,
            '',
            `${call.method} ${call.path}${call.destructive ? ' -- destructive' : ''}`,
        ].filter((l) => l.length > 0).join('\n     * ');

        callEntries.push(
            `    /**\n     * ${doc}\n     */\n`
            + `    ${JSON.stringify(call.key)}: /* @__PURE__ */ call<${inputType}, ${outputType}, never>(${JSON.stringify(call.method)}, ${JSON.stringify(call.path)}, ${gate}${options}),`,
        );
    }

    // What the api streams over `${base}/events`. mesh-web's models read this to decide that a
    // collection is live -- that its rows follow `<name>.created`/`.updated`/`.deleted` instead of
    // being refetched after every write -- so a client rendered without it refetched forever.
    // Only written when there are some, so an api with no events renders the text it always did.
    // (`?? []`: a descriptor read from an api older than events has no `events` at all.)
    const events = descriptor.events ?? [];

    // Each event's payload typed and checkable: its type, its schema (declared by the type, like a
    // call's), a name -> payload type map and a name -> schema map. An event the api describes no
    // payload for is `unknown`. Only written when there are events, as `events` below.
    const apiName = camelIdentifier(id);
    const eventMap: string[] = [];
    const eventSchemas: string[] = [];
    for (const event of events) {
        if (event.payload === undefined) {
            eventMap.push(`    ${JSON.stringify(event.name)}: unknown;`);
            continue;
        }
        const name = `${pascalCase(event.name)}Event`;
        const schemaName = `${lowerFirst(name)}Schema`;
        schemas.push(schemaDeclaration(schemaName, name, undefined, event.payload));
        eventMap.push(`    ${JSON.stringify(event.name)}: ${name};`);
        eventSchemas.push(`    ${JSON.stringify(event.name)}: ${schemaName},`);
    }
    const eventsTypeName = `${apiName.charAt(0).toUpperCase()}${apiName.slice(1)}Events`;
    const eventDeclarations = events.length === 0 ? [] : [
        `export type ${eventsTypeName} = {`,
        ...eventMap,
        '};',
        `export type ${eventsTypeName.slice(0, -1)}Name = keyof ${eventsTypeName};`,
        '',
        `export const ${apiName}EventSchemas = /* @__PURE__ */ (() => ({`,
        ...eventSchemas,
        '}))();',
        '',
    ];

    const eventEntries = events.length === 0 ? [] : [
        '    events: [',
        ...events.map((event) => `        { name: ${JSON.stringify(event.name)}${
            event.gate !== undefined ? `, gate: { kind: 'role', role: ${JSON.stringify(event.gate.role)} }` : ''} },`),
        '    ],',
    ];

    const lines = [
        '// @ts-nocheck -- every type below is written out; checking the zod expressions only repeats them.',
        '// GENERATED FILE -- do not edit.',
        '//',
        `// Rendered from ${descriptor.host}'s live exposure (its /api/_describe).`,
        `// Exposure: ${descriptor.exposure}`,
        `// ShapeHash: ${descriptor.shapeHash}`,
        '//',
        '// Regenerate rather than editing. The exposure and shape hashes above are checked at run time',
        "// against what the API reports, so a hand-edited client is a client that lies about a surface",
        '// nobody can verify. Self-contained: no import of mesh-serve anywhere below -- every schema',
        '// is real zod, rendered fresh into this file, using whichever zod this project has installed.',
        '',
        "import { z } from 'zod';",
        "import { call, defineApi } from '@flybyme/mesh-web/net';",
        '',
        ...schemas,
        '',
        ...eventDeclarations,
        // Pure: a bundle that never uses the api drops it, and with it every input schema it holds.
        'export const ' + apiExportName(id) + ' = /* @__PURE__ */ defineApi({',
        `    id: ${JSON.stringify(id)},`,
        `    exposure: ${JSON.stringify(descriptor.exposure)},`,
        `    shapeHash: ${JSON.stringify(descriptor.shapeHash)},`,
        `    base: ${JSON.stringify(descriptor.base)},`,
        '    calls: {',
        ...callEntries,
        '    },',
        ...eventEntries,
        '});',
        '',
    ];

    return lines.join('\n');
}
