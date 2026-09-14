import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import type { MetaCommand } from '../metaCommand.js';
import { ensureDescriptor } from '../ensureDescriptor.js';

const generateInputSchema = z.object({
    site: z.string().min(1).describe('The serve.site id to render a client for'),
    wants: z.string().default('./mesh.wants.json').describe('Local file listing the contract keys this app calls, same format the builder reads from a repo'),
    out: z.string().default('./generated/api.ts').describe('Where to write the generated client'),
});

async function readWants(file: string): Promise<string[] | undefined> {
    let raw: string;
    try {
        raw = await fs.readFile(file, 'utf8');
    } catch {
        return undefined;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === 'string')) {
        throw new Error(`${file} must be a JSON array of contract key strings.`);
    }
    return parsed;
}

/**
 * The local-dev half of "generate a browser-safe client" (the other half is whatever the cdn does
 * at release-build time, against the same serve.api.generateClient call): read this repo's own
 * mesh.wants.json -- the same file the builder reads server-side once this part is actually
 * imported -- so a local generate narrows to what this app calls rather than everything the target
 * site happens to expose, then ask the site's own api to render it. The rendering itself never runs
 * here: it needs mesh-serve's own zod, which is exactly the cross-package reference this whole
 * design exists to avoid shipping to a consumer.
 */
export const generateCommand: MetaCommand<z.infer<typeof generateInputSchema>> = {
    name: 'generate',
    description: 'generate --site <id> [--wants file] [--out file]: render this app\'s typed client',
    input: generateInputSchema,
    async run({ site, wants, out }, { session, client }) {
        const contracts = await readWants(wants);
        if (contracts === undefined) {
            console.log(`No ${wants} -- rendering everything "${site}" exposes.`);
        }

        const descriptor = await ensureDescriptor(session, client);
        const call = descriptor.calls.find((c) => c.key === 'serve.api.generateClient');
        if (call === undefined) {
            console.error(`"serve.api.generateClient" is not exposed at ${session.apiHost}.`);
            return;
        }

        const result = await client.call(session, call, { siteId: site, contracts });
        const body = result.body as { source?: unknown };
        if (typeof body.source !== 'string') {
            console.error('generateClient did not return source.');
            return;
        }

        await fs.mkdir(path.dirname(out), { recursive: true });
        await fs.writeFile(out, body.source);
        console.log(`Wrote ${out} (${body.source.length} bytes).`);
    },
};
