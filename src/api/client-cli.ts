#!/usr/bin/env node
/**
 * `mesh-serve client` — a part repository's `mesh.json` in, typed API code out.
 *
 * This is the missing half. mesh-api already had *descriptor → typed client* (`emitClient`), which
 * reads JSON and needs no cluster. What nothing did was produce the descriptor **from what a part
 * declares it calls** — and without that, every part hand-writes the shapes it receives. mesh-auth is
 * the live example: `IssueReply` and `WhoamiReply` are a second copy of this repository's identity
 * output schemas, in another repository, with nothing checking they still agree.
 *
 * ```
 * mesh.json  →  contracts, by key  →  descriptor.json  →  src/generated/<name>.ts
 * ```
 *
 * ## Two files, on purpose
 *
 * `descriptor.json` is committed, for lockfile reasons. The editor works offline, CI is reproducible
 * with nothing running, and **a contract changing is a reviewable line in a pull request** rather
 * than a surprise at runtime.
 *
 * ## Where this belongs eventually
 *
 * Not here. A part repository already depends on the browser framework and must never depend on the
 * server — running this today means a UI repository installs a web server to get types, which is
 * exactly what `spec/exposure.md` §4 objects to. The split that fixes it: **this half stays** (it
 * needs the contracts, which live here), and *descriptor → types* moves to mesh-web, so a part
 * repository regenerates offline from the committed descriptor with no server dependency at all.
 * Roadmap D5.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { globalContractRegistry, type ToolContract, type z } from '@flybyme/mesh';

import { parseDescriptor, type Descriptor } from '../builder/schema/descriptor.js';
import { emitClient } from './methods/client.js';
import { describeExposure } from './schema/descriptor.js';
import type { ExposeEntry } from './schema/expose.js';

export interface ClientArgs {
    /** The part repository's `mesh.json`. */
    readonly descriptor: string;
    readonly out: string;
    readonly descriptorOut: string;
    /** Fail instead of writing, for CI. */
    readonly check: boolean;
}

export function parseArgs(argv: readonly string[]): ClientArgs {
    const value = (flag: string): string | undefined => {
        const at = argv.indexOf(flag);
        return at === -1 ? undefined : argv[at + 1];
    };

    return {
        descriptor: value('--descriptor') ?? 'mesh.json',
        out: value('--out') ?? 'src/generated/api.ts',
        descriptorOut: value('--descriptor-out') ?? 'descriptor.json',
        check: argv.includes('--check'),
    };
}

/**
 * Every contract key the repository declares, with the package that is supposed to export it.
 *
 * Flattened across parts and de-duplicated: two parts in one repository calling the same contract
 * need one generated type, not two.
 *
 * **Through the real parser**, not a loose reader of the same file. The first version of this walked
 * `parts[].mesh[]` by hand and silently found nothing the moment a repository used the flat
 * single-part form — a generator that reports *"declares no contracts"* for a file that plainly
 * declares three. One parser, so a shape either file can write is a shape both halves understand.
 */
export function requestedContracts(descriptor: Descriptor): Map<string, string> {
    const wanted = new Map<string, string>();

    for (const part of descriptor.parts) {
        for (const dependency of part.mesh) {
            for (const key of dependency.contracts) wanted.set(key, dependency.package);
        }
    }

    return wanted;
}

/**
 * Resolve declared keys to real contracts.
 *
 * **This is the check that a name gets back what an import used to give for free.** A part names
 * `"identity.whoami"` as a string; with an imported `ToolContract` a typo was a compile error, and a
 * string typo is a 404 that looks exactly like a route that never existed. Refusing here, by name,
 * is what recovers it.
 *
 * The registry is populated at import time — which is why the package has to be imported first, and
 * why this is the one place that legitimately does a dynamic import of somebody else's package.
 */
export function resolveContracts(
    wanted: ReadonlyMap<string, string>,
): { entries: ExposeEntry[]; missing: string[] } {
    const entries: ExposeEntry[] = [];
    const missing: string[] = [];

    for (const [key, pkg] of wanted) {
        const contract = globalContractRegistry.get(key) as
            ToolContract<z.ZodTypeAny, z.ZodTypeAny> | undefined;

        if (contract === undefined) {
            missing.push(`${key} (declared from ${pkg})`);
            continue;
        }

        /**
         * `auth: 'public'` for every entry, and it is **not** a gate being granted.
         *
         * A part declares what it *calls*; a site declares what it *exposes and at what level*. A
         * part must never choose its own gate. This descriptor exists to carry request and response
         * *shapes* into a type generator, and the gate is a field `describeExposure` requires — so
         * one value is used uniformly and it means nothing here.
         *
         * The consequence, and it is worth knowing: **the exposure hash in this file is not the
         * site's.** A site's hash is computed over real gates. So a part's hash cannot be compared
         * against what an API reports, and the check has to happen at compose time, where the site's
         * grants are actually known. See roadmap D4.
         */
        entries.push({ contract, auth: 'public' });
    }

    return { entries, missing };
}

export async function run(argv: readonly string[]): Promise<number> {
    const args = parseArgs(argv);

    const mesh = parseDescriptor(readFileSync(resolve(args.descriptor), 'utf8'));
    const wanted = requestedContracts(mesh);

    if (wanted.size === 0) {
        process.stderr.write(`${args.descriptor} declares no contracts, so there is nothing to generate.\n`);
        return 0;
    }

    // Importing the package is what registers its contracts. Done before resolution rather than
    // lazily, so a package that cannot be loaded is reported as that instead of as missing contracts.
    for (const pkg of new Set(wanted.values())) {
        try {
            await import(pkg);
        } catch (error) {
            process.stderr.write(
                `Could not load ${pkg}, which ${args.descriptor} declares: ` +
                `${error instanceof Error ? error.message : String(error)}\n`,
            );
            return 1;
        }
    }

    const { entries, missing } = resolveContracts(wanted);

    if (missing.length > 0) {
        process.stderr.write(
            `These contracts are declared and not exported:\n  ${missing.join('\n  ')}\n` +
            `A contract named as a string is only as good as this check.\n`,
        );
        return 1;
    }

    const application = mesh.parts[0]?.id ?? 'part';
    const descriptor = describeExposure(entries, { application });
    const code = emitClient(descriptor, { name: `${application.replace(/\W/g, '')}Api` });

    if (args.check) {
        const held = readOr(args.descriptorOut);
        if (held !== JSON.stringify(descriptor, null, 4)) {
            process.stderr.write(`${args.descriptorOut} is out of date. Run the generator.\n`);
            return 1;
        }
        return 0;
    }

    write(args.descriptorOut, `${JSON.stringify(descriptor, null, 4)}\n`);
    write(args.out, code);

    process.stdout.write(
        `${String(descriptor.calls.length)} contract(s) → ${args.out}\n` +
        `exposure ${descriptor.exposure}\n`,
    );
    return 0;
}

const readOr = (path: string): string | undefined => {
    try { return readFileSync(resolve(path), 'utf8').trimEnd(); } catch { return undefined; }
};

function write(path: string, content: string): void {
    const full = resolve(path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
}
