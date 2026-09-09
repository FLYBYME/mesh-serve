/**
 * Bring a cluster up from nothing: sign in, and seed a hostname.
 *
 * **This used to join the mesh.** It constructed a `MeshApp`, dialled the cluster as a peer, and
 * called contracts directly with a `meta` it built itself — `callerFor(userId, orgId, ['operator'])`.
 * That is roadmap **D6** in its purest form: any peer completing the handshake may assert any
 * identity, so `requireOperator` read what this script said about itself and `scopedBy` narrowed by
 * a tenant it named. `MESH_KEY` was not one boundary among several; it was the only one.
 *
 * D6's real fix is a broker-level check and it is marked ⛔ mesh. `mesh/docs/STABILITY.md` froze
 * mesh, so the door closes instead: **everything mesh-serve provides is reachable through its API
 * and its CLI, and through nothing else.** `publish-cli` was moved off the same shape by F6 on
 * 2026-09-06; this was the last one left.
 *
 * What is left is small on purpose. The ten steps this used to orchestrate are `site.seed`, a
 * contract on the node — so a browser does the same thing by making the same call, rather than
 * reimplementing an orchestration that lives in a CLI.
 *
 * ```
 * node bin/mesh-serve.mjs node --db …    # the cluster: prints a first-boot password once
 * npx mesh-serve seed --host … --repo …  # this, over HTTP, signed in
 * ```
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? fallback : (argv[at + 1] ?? fallback);
};
const optional = (name: string): string | undefined => {
    const value = flag(name, '');
    return value === '' ? undefined : value;
};
const has = (name: string): boolean => argv.includes(`--${name}`);
const every = (name: string): string[] => argv
    .map((word, at) => (word === `--${name}` ? argv[at + 1] : undefined))
    .filter((value): value is string => value !== undefined && value !== '');

/**
 * `.env` for credentials, like the node's own.
 *
 * Not a command line: a value typed as `PASSWORD=… npx …` is visible in `ps` to every user on the
 * machine and lands in a shell history.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
    process.loadEnvFile(path.join(repoRoot, '.env'));
} catch {
    // No `.env` is fine — an already-exported value wins anyway, and a fresh cluster prints its
    // first password to the terminal rather than reading one from a file.
}

/**
 * Where a node answers as itself.
 *
 * The control site (`cdn/methods/control.ts`), created at boot, is what makes a cluster with no
 * sites reachable at all. Before it existed there was nothing to point a CLI at, which is why this
 * file used to go around the api entirely.
 */
const DEFAULT_CONTROL = 'http://127.0.0.1:5005';

/** `0.16.1` → `^0.16`. Exported because `test/api/bring-up.test.ts` asserts the rule. */
export function rangeFor(version: string): string {
    const [major, minor] = version.split('.');
    return major === undefined || minor === undefined ? `^${version}` : `^${major}.${minor}`;
}

interface Answer { readonly status: number; readonly body: unknown }

async function post(base: string, route: string, input: unknown, ticket?: string): Promise<Answer> {
    const response = await fetch(`${base}/api${route}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(ticket === undefined ? {} : { authorization: `Bearer ${ticket}` }),
        },
        body: JSON.stringify(input),
    });
    return { status: response.status, body: await response.json().catch(() => undefined) };
}

const messageOf = (body: unknown): string =>
    (typeof body === 'object' && body !== null && 'message' in body
        && typeof (body as { message: unknown }).message === 'string')
        ? (body as { message: string }).message
        : JSON.stringify(body);

/**
 * Sign in, claiming a first-boot account on the way if that is what this is.
 *
 * The account identity creates on a fresh cluster is `provisional`: refused by the gate everywhere
 * above `public` except `identity.set_password`, and doing that clears the flag. So a first run is
 * two sign-ins with a password change between them — the second is needed because setting a password
 * revokes the sessions it was set from, which is ordinary and is also what makes the claim take
 * effect immediately rather than when a cache expires.
 */
async function signIn(base: string, email: string, password: string, claim?: string): Promise<string> {
    const issued = await post(base, '/identity/ticket', { email, password });
    if (issued.status >= 400) {
        throw new Error(
            `Could not sign in to ${base} as ${email}: ${messageOf(issued.body)}\n\n`
            + 'A cluster on its first boot prints an account and a password to the node\'s own '
            + 'terminal, once. Pass them as --email and --password.',
        );
    }

    const ticket = (issued.body as { token?: string }).token;
    if (ticket === undefined) throw new Error('Signing in produced no ticket.');

    if (claim === undefined) return ticket;

    const set = await post(base, '/identity/password', { password: claim }, ticket);
    if (set.status >= 400) throw new Error(`Could not set a password: ${messageOf(set.body)}`);

    if ((set.body as { claimed?: boolean }).claimed === true) {
        console.log('[identity] account claimed — the printed password no longer works');
    }

    // The ticket above died with the password change, which is the point of revoking on a change.
    return await signIn(base, email, claim);
}

export async function main(): Promise<void> {
    const base = (optional('control') ?? process.env['MESH_CONTROL'] ?? DEFAULT_CONTROL).replace(/\/$/, '');
    const email = flag('email', process.env['USER_EMAIL'] ?? 'operator@node.invalid');
    const password = flag('password', process.env['USER_PASSWORD'] ?? '');

    if (password === '') {
        throw new Error(
            'No password. A cluster on its first boot prints an account and a password to the '
            + 'node\'s own terminal, once — pass it as --password, or set USER_PASSWORD in .env.',
        );
    }

    const ticket = await signIn(base, email, password, optional('set-password'));
    console.log(`[identity] signed in to ${base} as ${email}`);

    const repos = every('repo');
    if (repos.length === 0) {
        console.log('\nSigned in and nothing to seed. Pass --repo <git url or path> to seed a site.');
        return;
    }

    const host = optional('host');
    if (host === undefined) throw new Error('Which hostname? Pass --host.');

    const only = optional('parts')?.split(',').map((part) => part.trim()).filter((part) => part !== '');
    const orgSlug = optional('org-slug');

    console.log(`[seed] ${host} ← ${String(repos.length)} repositor(y|ies)`);

    /**
     * **One call.** Import, release, compose, grant, deploy — `site.seed` on the node.
     *
     * It can take minutes: it clones every repository and bundles every part. `fetch` has no
     * timeout of its own, which is right here — the failure this replaces was a caller giving up at
     * ten seconds while the builder carried on and finished correctly, so the run *failed* and the
     * work *succeeded*.
     */
    const seeded = await post(base, '/sites/seed', {
        host,
        sources: repos.map((repository) => ({
            repository,
            ...(optional('ref') === undefined ? {} : { ref: optional('ref') }),
        })),
        ...(only === undefined ? {} : { parts: only }),
        ...(orgSlug === undefined ? {} : {
            organization: { slug: orgSlug, name: optional('org-name') ?? orgSlug },
        }),
        ...(optional('application') === undefined ? {} : { application: optional('application') }),
        ...(optional('title') === undefined ? {} : { title: optional('title') }),
        ...(optional('api') === undefined ? {} : { api: optional('api') }),
        ...(has('import-only') ? { importOnly: true } : {}),
    }, ticket);

    if (seeded.status >= 400) throw new Error(messageOf(seeded.body));

    const result = seeded.body as {
        host: string; release?: string;
        parts: readonly { name: string; version: string; kind: string }[];
        problems: readonly string[];
    };

    for (const part of result.parts) {
        console.log(`[seed]   ${part.kind} ${part.name}@${part.version}`);
    }
    for (const problem of result.problems) console.error(`[seed]   ${problem}`);

    console.log(
        result.release === undefined
            ? `\n[seed] ${result.host}: imported, nothing composed.\n`
            : `\n[seed] ${result.host} → ${result.release}\n`,
    );
}
