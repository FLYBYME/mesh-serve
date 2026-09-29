import { jsonSchemaToZod } from 'json-schema-to-zod';

import { buildDescriptor, type DeclarationLookup, type ExposureDescriptor } from './descriptor.js';
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
        if (!isEmptyObjectSchema(call.input)) {
            const schemaName = `${lowerFirst(name)}InputSchema`;
            schemas.push(jsonSchemaToZod(call.input as Record<string, unknown>, {
                name: schemaName,
                module: 'esm',
                // `XInput` stays what it was — the parsed shape (`z.infer`), which the server sees.
                type: `${name}Input`,
                noImport: true,
            }));
            // A *caller* passes the schema's input side: a field with a default may be left out.
            // Typing the call with `z.infer` made every defaulted field required at every call site
            // (`domain.find` demanded `offset`, found by the company site's dashboard).
            inputType = `z.input<typeof ${schemaName}>`;
        }

        const outputType = `${name}Output`;
        schemas.push(jsonSchemaToZod(call.output as Record<string, unknown>, {
            name: `${lowerFirst(name)}OutputSchema`,
            module: 'esm',
            type: outputType,
            noImport: true,
        }));

        const gate = gateLiteral(call.gate);
        const doc = [
            call.description,
            '',
            `${call.method} ${call.path}${call.destructive ? ' -- destructive' : ''}`,
        ].filter((l) => l.length > 0).join('\n     * ');

        callEntries.push(
            `    /**\n     * ${doc}\n     */\n`
            + `    ${JSON.stringify(call.key)}: call<${inputType}, ${outputType}, never>(${JSON.stringify(call.method)}, ${JSON.stringify(call.path)}, ${gate}),`,
        );
    }

    const lines = [
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
        'export const ' + camelIdentifier(id) + 'Api = defineApi({',
        `    id: ${JSON.stringify(id)},`,
        `    exposure: ${JSON.stringify(descriptor.exposure)},`,
        `    shapeHash: ${JSON.stringify(descriptor.shapeHash)},`,
        `    base: ${JSON.stringify(descriptor.base)},`,
        '    calls: {',
        ...callEntries,
        '    },',
        '});',
        '',
    ];

    return lines.join('\n');
}
