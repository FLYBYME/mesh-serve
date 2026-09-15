import { jsonSchemaToZod } from 'json-schema-to-zod';

import { buildDescriptor } from './descriptor.js';
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

function gateLiteral(row: Expose | undefined): string {
    if (row?.permission !== undefined) return `{ kind: 'permission', permission: ${JSON.stringify(row.permission)} }`;
    if (row?.role !== undefined) return `{ kind: 'role', role: ${JSON.stringify(row.role)} }`;
    return 'undefined';
}

export async function generateClient(id: string, host: string, rows: readonly Expose[]): Promise<string> {
    const descriptor = buildDescriptor(host, rows);
    const rowByKey = new Map(rows.map((r) => [r.contract, r]));

    const schemas: string[] = [];
    const callEntries: string[] = [];

    for (const call of descriptor.calls) {
        const name = pascalCase(call.key);

        let inputType = 'void';
        if (!isEmptyObjectSchema(call.input)) {
            const inputType_ = `${name}Input`;
            schemas.push(jsonSchemaToZod(call.input as Record<string, unknown>, {
                name: `${lowerFirst(name)}InputSchema`,
                module: 'esm',
                type: inputType_,
                noImport: true,
            }));
            inputType = inputType_;
        }

        const outputType = `${name}Output`;
        schemas.push(jsonSchemaToZod(call.output as Record<string, unknown>, {
            name: `${lowerFirst(name)}OutputSchema`,
            module: 'esm',
            type: outputType,
            noImport: true,
        }));

        const gate = gateLiteral(rowByKey.get(call.key));
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
        `// Emitted from ${host}'s live exposure by serve.api.generateClient.`,
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
