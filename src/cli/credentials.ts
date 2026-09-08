/**
 * **A ticket per host, on disk.**
 *
 * `mesh-serve login` once, every later command uses it. The CLI holds a credential the same way a
 * browser does — issued by `identity.ticket_issue`, sent as a bearer token, refused when it expires.
 *
 * It does **not** mint its own caller. `src/bring-up.ts` does, and `publish-cli` did until roadmap
 * **F6** — *"the CLI minted its own caller and nothing checked it"*. Two ways to become somebody is
 * one too many, and the second is always the weaker.
 *
 * See `spec/cli.md` §4.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * `~/.mesh-serve/credentials.json`, mode 0600.
 *
 * A file, not the environment: a value exported into a shell is visible in `ps` to every user on the
 * machine and lands in a history file. `MESH_TICKET` is still honoured for CI, where there is no
 * home directory worth writing to and the secret arrived some other way.
 */
const FILE = join(homedir(), '.mesh-serve', 'credentials.json');

interface Entry { readonly ticket: string; readonly email?: string; readonly issuedAt: number }

interface Stored {
    /** The host later commands use when none is given. Set by `login`. */
    readonly current?: string;
    readonly hosts?: Readonly<Record<string, Entry>>;
}

const read = (): Stored => {
    try {
        return JSON.parse(readFileSync(FILE, 'utf8')) as Stored;
    } catch {
        // No file, unreadable, or corrupt. All three mean "not signed in", which is a state and not
        // an error — a CLI that refuses to start because a cache is malformed is a CLI that has to
        // be repaired before it can be used.
        return {};
    }
};

const write = (stored: Stored): void => {
    mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
    writeFileSync(FILE, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    // Set again after writing: an existing file keeps its old mode, and the first write of a session
    // is rarely the one that created it.
    chmodSync(FILE, 0o600);
};

export const ticketFor = (host: string): string | undefined =>
    process.env['MESH_TICKET'] ?? read().hosts?.[host]?.ticket;

export const emailFor = (host: string): string | undefined => read().hosts?.[host]?.email;

/**
 * **The host `login` last signed into, used when a command names none.**
 *
 * You say it once and stop saying it, which is what a person expects and what every other tool of
 * this shape does.
 *
 * It is also how somebody deploys to production believing they are on staging — so `whoami` and the
 * help both print which host is current, and an explicit `--host` always wins. A remembered value
 * that is never shown is the dangerous version of this feature.
 */
export const currentHost = (): string | undefined => process.env['MESH_HOST'] ?? read().current;

export function saveTicket(host: string, ticket: string, email?: string): void {
    const stored = read();
    write({
        current: host,
        hosts: {
            ...stored.hosts,
            [host]: { ticket, issuedAt: Date.now(), ...(email === undefined ? {} : { email }) },
        },
    });
}

export function forgetTicket(host: string): void {
    const stored = read();
    const hosts = { ...stored.hosts };
    // Deleted rather than blanked. A key holding an empty string reads as "signed in as nobody",
    // which is a state the rest of this has no meaning for.
    delete hosts[host];
    write({
        // Signing out of the current host leaves none current: the alternative is a later command
        // silently running against a different site than the one you just left.
        ...(stored.current === host ? {} : { current: stored.current }),
        hosts,
    });
}

export const credentialsPath = FILE;
