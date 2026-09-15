import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Standalone "generate a browser-safe client" script -- plain fetch, nothing from src/cli/*.
 * Deliberately independent of the CLI (which may not exist later): this is the actual mechanism a
 * consuming app (e.g. mesh-operator's console) uses to regenerate its generated/api.ts, so it can't
 * depend on tooling that isn't guaranteed to stick around.
 *
 * Run against an already-running api server, pointed at a site whose serve.expose rows list every
 * contract the consuming app calls:
 *
 *   API_HOST=control-api.localhost API_PORT=5005 \
 *   SITE_ID=<site id> DEMO_EMAIL=op@example.com DEMO_PASSWORD=... \
 *   OUT=../mesh-operator/src/console/generated/api.ts \
 *   npx tsx src/examples/generateClient.ts
 */

const apiHost = `${process.env.API_HOST ?? 'api.localhost'}:${process.env.API_PORT ?? '5005'}`;
const email = process.env.DEMO_EMAIL ?? 'demo@example.com';
const password = process.env.DEMO_PASSWORD ?? 'password123';
const siteId = process.env.SITE_ID;
const out = process.env.OUT ?? './generated-api.ts';

interface DescribedCall {
    readonly key: string;
    readonly method: string;
    readonly path: string;
}

interface Descriptor {
    readonly base: string;
    readonly calls: readonly DescribedCall[];
}

function baseUrl(): string {
    return apiHost.startsWith('http://') || apiHost.startsWith('https://') ? apiHost : `http://${apiHost}`;
}

async function call(descriptor: Descriptor, key: string, input: unknown, token?: string): Promise<unknown> {
    const decl = descriptor.calls.find((c) => c.key === key);
    if (decl === undefined) {
        throw new Error(`"${key}" is not exposed at ${apiHost}.`);
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token !== undefined) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch(`${baseUrl()}${descriptor.base}${decl.path}`, { method: decl.method, headers, body: JSON.stringify(input) });
    const text = await res.text();
    const body = text.length > 0 ? JSON.parse(text) as unknown : undefined;
    if (!res.ok) {
        throw new Error(`${key} failed: ${res.status} ${JSON.stringify(body)}`);
    }
    return body;
}

async function main(): Promise<void> {
    if (siteId === undefined) {
        throw new Error('SITE_ID is required -- which site\'s exposure to render a client for.');
    }

    const descriptorRes = await fetch(`${baseUrl()}/api/_describe`);
    const descriptor = await descriptorRes.json() as Descriptor;
    console.log(`connected to ${apiHost}, ${descriptor.calls.length} contracts exposed`);

    // Ignored if the account already exists -- this script is meant to be re-run.
    try {
        await call(descriptor, 'identity.user.register', { email, password, displayName: 'Demo User' });
        console.log(`registered ${email}`);
    } catch (err) {
        console.log(`register skipped: ${err instanceof Error ? err.message : String(err)}`);
    }

    const ticket = await call(descriptor, 'identity.ticket.issue', { email, password }) as { token: string };
    console.log('issued ticket');

    const result = await call(descriptor, 'serve.api.generateClient', { siteId }, ticket.token) as { source: string };

    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, result.source);
    console.log(`wrote ${out} (${result.source.length} bytes)`);
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
});
