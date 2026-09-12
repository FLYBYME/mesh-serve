/**
 * The CLI.
 *
 * `spec/cli.md`. Three commands are about the terminal — `login`, `logout`, `whoami` — and
 * everything else is **a contract, reached by name**, with its flags taken from the contract's own
 * input schema. A hand-written command is a second declaration of something already declared, and it
 * drifts: `src/cli` existed in the deleted tree and the shipped CLI did not use it.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { call, Refused, type ClientOptions } from './client.js';
import { forgetTicket, saveTicket, ticketFor } from './credentials.js';
import { decodeQueryValue } from '../serve/methods/routes.js';

/** A flag's value: a string, a bare `--flag`, or a flag given more than once. */
export type FlagValue = string | boolean | string[];

export interface Argv {
    readonly command: string;
    readonly rest: readonly string[];
    readonly flags: Readonly<Record<string, FlagValue>>;
}

/**
 * Parse `--flag value` and `--flag`.
 *
 * A flag with no value is `true`, which is what `--yes` and `--json` want. **An unknown flag is not
 * silently dropped** — the caller of this decides, and `spec/building.md` records what silent
 * dropping cost: `--policy '{...}'` was typed, nothing knew the flag, nothing said so, and the seed
 * reported success having set no policy at all.
 */
export function parseArgv(argv: readonly string[]): Argv {
    const words: string[] = [];
    const flags: Record<string, FlagValue> = {};

    for (let at = 0; at < argv.length; at += 1) {
        const word = argv[at];
        if (word === undefined) continue;

        if (!word.startsWith('--')) {
            words.push(word);
            continue;
        }

        const name = word.slice(2);
        const next = argv[at + 1];

        if (next === undefined || next.startsWith('--')) {
            flags[name] = true;
            continue;
        }

        /**
         * **A flag given twice is a list**, which is how a terminal says *array* without anybody
         * inventing a separator.
         *
         * A contract taking `partIds: string[]` was unreachable from the CLI: the last value won and
         * the schema refused a string where it wanted an array. Comma-splitting was the obvious
         * alternative and is wrong — a value containing a comma is then unrepresentable, and the
         * user's own rule about this platform is *no comma separated shit*.
         */
        const existing = flags[name];
        flags[name] = existing === undefined || typeof existing === 'boolean'
            ? next
            : [...(Array.isArray(existing) ? existing : [existing]), next];

        at += 1;
    }

    const [command = 'help', ...rest] = words;
    return { command, rest, flags };
}

/** One property of a contract's input, as the site's description carries it. */
interface InputProperty {
    readonly type?: string;
    readonly items?: unknown;
}

/**
 * A flag's value, shaped for the contract that will receive it.
 *
 * **The shape comes from the contract**, which is the whole reason the site's description carries the
 * input schema. `--limit 5` is a number and `--partIds x` is an array of one because those contracts
 * say so, and nothing in this file knows what a limit or a release is.
 *
 * Without the schema a single `--partIds x` was refused with *"Expected array, received string"* —
 * true, unhelpful, and unfixable from the terminal without inventing a separator.
 *
 * Repeating a flag still makes a list, and it is the better habit for a value that might contain
 * anything. Falling back to the query-string decoder covers a contract whose schema did not travel.
 */
function flagValue(value: FlagValue, declared: InputProperty | undefined): unknown {
    const type = declared?.type;

    if (type === 'array') {
        if (Array.isArray(value)) return value;
        if (typeof value === 'boolean') return [];
        // A single value is a list of one. It is what the person meant, and the alternative is
        // telling them their argument has the wrong shape for a shape they cannot type.
        const decoded = decodeQueryValue(value);
        return Array.isArray(decoded) ? decoded : [value];
    }

    if (Array.isArray(value)) return value;
    if (typeof value === 'boolean') return value;

    if (type === 'string') return value;
    if (type === 'number' || type === 'integer') return Number(value);
    if (type === 'boolean') return value === 'true';

    return decodeQueryValue(value);
}

/** The declared properties of a contract's input, if the description carried a schema. */
function propertiesOf(input: unknown): Readonly<Record<string, InputProperty>> {
    if (typeof input !== 'object' || input === null) return {};
    const properties = (input as { properties?: unknown }).properties;
    if (typeof properties !== 'object' || properties === null) return {};
    return properties as Record<string, InputProperty>;
}

const stringFlag = (flags: Argv['flags'], name: string): string | undefined => {
    const value = flags[name];
    return typeof value === 'string' ? value : undefined;
};

/**
 * Ask for a secret without echoing it.
 *
 * **A password is never read from argv**, where it is visible in `ps` to every user on the machine
 * and lands in shell history. With no tty there is an environment variable and the error names it —
 * a script has a way through that is not *put it on the command line*.
 */
async function askSecret(prompt: string, envVar: string): Promise<string> {
    const fromEnv = process.env[envVar];
    if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;

    if (!stdin.isTTY) {
        throw new Refused(
            'NO_TTY',
            `There is no terminal to prompt on. Set ${envVar} instead — a password on the command `
            + `line is visible in ps and lands in shell history.`,
            0,
        );
    }

    const rl = createInterface({ input: stdin, output: stdout, terminal: true });

    // Suppress the echo by writing nothing for each keypress. readline still collects the line.
    const muted = (chunk: string | Uint8Array, encoding?: BufferEncoding, done?: () => void): boolean => {
        if (typeof done === 'function') done();
        void chunk; void encoding;
        return true;
    };

    stdout.write(prompt);
    const original = stdout.write.bind(stdout);
    (stdout as unknown as { write: typeof muted }).write = muted;

    try {
        const answer = await rl.question('');
        return answer;
    } finally {
        (stdout as unknown as { write: typeof original }).write = original;
        rl.close();
        stdout.write('\n');
    }
}

interface Whoami {
    readonly userId: string;
    readonly email: string;
    readonly displayName: string;
    readonly provisional: boolean;
    readonly organizations: readonly {
        readonly organizationId: string;
        readonly slug: string;
        readonly name: string;
        readonly roleKey: string;
    }[];
    readonly permissions: readonly { readonly permission: string; readonly scope?: string }[];
}

/**
 * **What `login` prints, and the reason it prints anything.**
 *
 * The previous one wrote the ticket and said nothing, which is indistinguishable from failing
 * silently — so the person runs it again. This is `spec/identity.md` §7's answer: who you are, and
 * the complete list of what this account can do, with scope as a column rather than as a separate
 * question a caller has to think to ask.
 */
function renderWhoami(who: Whoami, host: string): string {
    const lines = [`signed in as  ${who.email}  on ${host}`, ''];

    if (who.provisional) {
        lines.push(
            '  This account has not been claimed. It can do nothing except set its own password:',
            '',
            '    mesh-serve set-password',
            '',
        );
        return lines.join('\n');
    }

    if (who.permissions.length === 0) {
        lines.push('  This account holds no permissions anywhere yet.', '');
        return lines.join('\n');
    }

    /**
     * **A scope is an organization id on the wire and a name on the screen.**
     *
     * The id is what a caller passes back in a header, so it has to be what `--json` carries; a
     * person reading the list wants *Platform*. Printing the id to somebody was the first version,
     * and it reads as a failure rather than as an answer.
     */
    const scopeName = (scope: string | undefined): string => {
        if (scope === undefined) return 'everywhere';
        const org = who.organizations.find((o) => o.organizationId === scope);
        return org === undefined ? `in   ${scope}` : `in   ${org.name}`;
    };

    const width = Math.max(...who.permissions.map((p) => p.permission.length));
    for (const permission of who.permissions) {
        lines.push(`  ${permission.permission.padEnd(width)}   ${scopeName(permission.scope)}`);
    }

    lines.push('');
    return lines.join('\n');
}

export interface RunOptions {
    readonly out?: (text: string) => void;
    readonly err?: (text: string) => void;
}

/**
 * Run one command.
 *
 * Returns the process exit code rather than calling `process.exit`, so it can be tested and so a
 * failure is one value rather than a thrown thing that also has to be formatted somewhere else.
 */
export async function run(argv: readonly string[], options: RunOptions = {}): Promise<number> {
    const out = options.out ?? ((text) => stdout.write(text));
    const err = options.err ?? ((text) => process.stderr.write(text));

    const { command, rest, flags } = parseArgv(argv);

    /** `127.0.0.1`, because that is the only site a machine that just booted has. */
    const host = stringFlag(flags, 'host') ?? '127.0.0.1';
    const origin = stringFlag(flags, 'origin')
        ?? process.env['MESH_SERVE_API']
        ?? `http://${host}:5005`;

    const stored = ticketFor(host);
    const client: ClientOptions = { host, origin, ticket: stored?.ticket };

    try {
        switch (command) {
            case 'login': {
                const email = stringFlag(flags, 'email') ?? await ask('email: ');
                const password = await askSecret('password: ', 'MESH_SERVE_PASSWORD');

                const issued = await call(client, 'POST', '/identity/ticket', { email, password }) as {
                    token: string; userId: string; expiresAt: number; provisional: boolean;
                };

                const path = saveTicket(host, {
                    ticket: issued.token,
                    userId: issued.userId,
                    expiresAt: issued.expiresAt,
                });

                const who = await call(
                    { ...client, ticket: issued.token },
                    'GET',
                    '/identity/whoami',
                ).catch((error: unknown) => {
                    // A provisional account is refused by whoami, which is correct and is not a
                    // failed login. Say what it can do instead of showing it a refusal.
                    if (error instanceof Refused && error.code === 'PROVISIONAL_ACCOUNT') return undefined;
                    throw error;
                });

                out('\n');
                out(who === undefined
                    ? renderWhoami(
                        { userId: issued.userId, email, displayName: '', provisional: true, organizations: [], permissions: [] },
                        host,
                    )
                    : renderWhoami(who as Whoami, host));
                out(`  ticket saved to ${path}\n\n`);
                return 0;
            }

            case 'logout': {
                forgetTicket(host);
                if (stored !== undefined) {
                    // Best effort: the local ticket is gone either way, and a server that cannot be
                    // reached must not leave a credential on disk because the call failed.
                    await call(client, 'POST', '/identity/sign_out', { token: stored.ticket })
                        .catch(() => undefined);
                }
                out(`signed out of ${host}\n`);
                return 0;
            }

            case 'whoami': {
                const who = await call(client, 'GET', '/identity/whoami');
                out(flags['json'] === true ? `${JSON.stringify(who, null, 4)}\n` : renderWhoami(who as Whoami, host));
                return 0;
            }

            case 'set-password': {
                const password = await askSecret('new password: ', 'MESH_SERVE_NEW_PASSWORD');
                const again = await askSecret('again: ', 'MESH_SERVE_NEW_PASSWORD');

                if (password !== again) {
                    err('Those did not match. Nothing was changed.\n');
                    return 1;
                }

                const result = await call(client, 'POST', '/identity/password', { password }) as {
                    claimed: boolean;
                };

                // Every other session died, including this one. Saying so beats the next command
                // failing with a 401 that looks like something else.
                forgetTicket(host);
                out(result.claimed
                    ? 'password set, account claimed — sign in again\n'
                    : 'password set — every session ended, sign in again\n');
                return 0;
            }

            case 'describe': {
                const described = await call({ ...client, ticket: undefined }, 'GET', '/_describe');
                out(`${JSON.stringify(described, null, 4)}\n`);
                return 0;
            }

            case 'help':
            case '--help':
                out(usage());
                return 0;

            default:
                return await contractCommand(client, command, rest, flags, out, err);
        }
    } catch (error) {
        if (error instanceof Refused) {
            err(`${error.message}\n`);
            return 1;
        }
        throw error;
    }
}

/**
 * Anything that is not one of the terminal's own commands is **a contract**.
 *
 * `mesh-serve organization find` is `organization.find`, looked up in the site's own description —
 * so the CLI knows what exists because the site said so, not because this file has a list. A site
 * that exposes a contract this binary has never heard of is callable the day it is exposed.
 */
async function contractCommand(
    client: ClientOptions,
    noun: string,
    rest: readonly string[],
    flags: Argv['flags'],
    out: (text: string) => void,
    err: (text: string) => void,
): Promise<number> {
    const action = rest[0];
    if (action === undefined) {
        err(`"${noun}" needs an action: mesh-serve ${noun} find\n`);
        return 2;
    }

    const key = `${noun}.${action}`;
    const described = await call({ ...client, ticket: undefined }, 'GET', '/_describe') as {
        calls: readonly {
            key: string; method: string; path: string; destructive: boolean; input?: unknown;
        }[];
    };

    const found = described.calls.find((c) => c.key === key);
    if (found === undefined) {
        const near = described.calls.filter((c) => c.key.startsWith(`${noun}.`)).map((c) => c.key);
        err(near.length === 0
            ? `${client.host} serves nothing called "${noun}". Try: mesh-serve describe\n`
            : `${client.host} serves no "${key}". It does serve:\n${near.map((k) => `  ${k}\n`).join('')}`);
        return 2;
    }

    /**
     * **The contract says whether to ask, and the CLI asks.** One declaration, read by the terminal,
     * by a UI deciding whether to confirm, and by an agent surface deciding whether to park the call
     * for approval.
     */
    if (found.destructive && flags['yes'] !== true && stdin.isTTY) {
        const answer = await ask(`${key} changes things. Continue? [y/N] `);
        if (answer.trim().toLowerCase() !== 'y') {
            out('nothing was done\n');
            return 0;
        }
    }

    // The contract's own declaration of what it takes. Every flag is shaped by it.
    const declared = propertiesOf(found.input);

    const { path, query } = fillPath(found.path, flags, declared);
    const body = found.method === 'GET' ? undefined : bodyFrom(flags, declared);
    const url = query === '' ? path : `${path}?${query}`;

    const result = await call(client, found.method, url, body);
    out(`${JSON.stringify(result, null, 4)}\n`);
    return 0;
}

/**
 * Put flags into the path where the route names them, and the rest into the query string.
 *
 * `/sites/:id` with `--id x` becomes `/sites/x`, and a flag the route does not name stays a
 * parameter. **The route wins over the body at the server too** (`spec/collections.md` §4); doing it
 * here as well means the caller is not told about a conflict they could not have caused.
 */
function fillPath(
    pattern: string,
    flags: Argv['flags'],
    declared: Readonly<Record<string, InputProperty>>,
): { path: string; query: string } {
    const used = new Set<string>();

    const path = pattern.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_whole, name: string) => {
        const value = flags[name];
        if (typeof value !== 'string') return `:${name}`;
        used.add(name);
        return encodeURIComponent(value);
    });

    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(flags)) {
        if (used.has(name) || RESERVED.has(name)) continue;

        // Shaped first, then encoded. A list or an object becomes JSON, which is exactly what
        // `decodeQuery` parses on the other side — one encoding, decided in one place.
        const shaped = flagValue(value, declared[name]);
        params.set(name, typeof shaped === 'string' ? shaped : JSON.stringify(shaped));
    }

    return { path, query: params.toString() };
}

function bodyFrom(
    flags: Argv['flags'],
    declared: Readonly<Record<string, InputProperty>>,
): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(flags)) {
        if (RESERVED.has(name)) continue;
        body[name] = flagValue(value, declared[name]);
    }
    return body;
}

/** Flags that belong to the terminal rather than to the contract. */
const RESERVED = new Set(['host', 'origin', 'json', 'yes', 'help']);

async function ask(prompt: string): Promise<string> {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
        return await rl.question(prompt);
    } finally {
        rl.close();
    }
}

function usage(): string {
    return [
        '',
        'mesh-serve [--host <site>] <command>',
        '',
        '  login                 sign in, and print what this account may do',
        '  logout                end this session',
        '  whoami                who am I, and what may I do',
        '  set-password          set your own password',
        '  describe              what this site serves',
        '',
        '  <noun> <action>       call a contract — mesh-serve organization find',
        '                        flags become its input: --name platform',
        '',
        '  --host defaults to 127.0.0.1, which is the site a fresh node serves itself on.',
        '',
    ].join('\n');
}
