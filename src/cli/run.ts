/**
 * **The CLI: a site's exposure, as subcommands.**
 *
 * ```
 * mesh-serve --host <site> <domain> <action> [--flags]
 * ```
 *
 * The command tree is a **function of the host**. `mesh-serve` does not know what surfdns is and must
 * not — it knows how to read a descriptor, so the same binary gives a different command tree for
 * every site, none of them written down anywhere. A site exposing `domain.create` has a
 * `domain create` command *because it exposes it*, and a caller whose gate refuses it does not see
 * the command at all.
 *
 * That is what makes one client serve every project on the platform, and what makes a dedicated
 * client — surfdns's own `surf`, say — a layer over this rather than a reimplementation beside it.
 *
 * See `spec/cli.md`.
 */

import { describeInput, flagFor, missingRequired, parseArgs, type Schema } from './args.js';
import { callContract, fetchDescriptor, originOf, CliError, type Call, type Descriptor } from './descriptor.js';
import { credentialsPath, currentHost, emailFor, forgetTicket, saveTicket, ticketFor } from './credentials.js';

export interface Io {
    out(line: string): void;
    err(line: string): void;
    /** Asked for, never taken from argv: a password in argv is in `ps` and in a history file. */
    prompt(question: string, hidden: boolean): Promise<string>;
}

/**
 * Run one invocation. Returns the process exit code rather than calling `process.exit`, so this is
 * testable without a subprocess.
 */
export async function run(argv: readonly string[], io: Io): Promise<number> {
    // `--host` wins, then the host `login` remembered. Explicit beats remembered, always.
    const host = valueOf(argv, '--host') ?? currentHost();
    const rest = withoutFlag(argv, '--host');
    const asJson = rest.includes('--json');
    const words = rest.filter((a) => !a.startsWith('--'));
    const [first, second] = words;

    try {
        if (first === undefined || first === 'help') {
            return await help(host, io);
        }

        if (first === 'login') return await login(requireHost(host), rest, io);
        if (first === 'logout') { forgetTicket(requireHost(host)); io.out(`Signed out of ${requireHost(host)}.`); return 0; }

        const site = requireHost(host);
        const ticket = ticketFor(site);
        const descriptor = await fetchDescriptor(site, ticket);

        if (first === 'whoami') return whoami(site, io);
        if (first === 'set-password') return await setPassword(site, descriptor, ticket, io);

        if (second === undefined) return await domainHelp(descriptor, first, io);

        const call = descriptor.calls.find((c) => c.domain === first && c.action === second);
        if (call === undefined) return await unknown(descriptor, first, second, io);

        return await invoke(site, descriptor, call, rest, ticket, asJson, io);
    } catch (error) {
        if (error instanceof CliError) {
            io.err(error.message);
            if (error.hint !== undefined) io.err(`\n${error.hint}`);
            return 1;
        }
        io.err(error instanceof Error ? error.message : String(error));
        return 1;
    }
}

// ---------------------------------------------------------------------------- invoking

async function invoke(
    host: string,
    descriptor: Descriptor,
    call: Call,
    argv: readonly string[],
    ticket: string | undefined,
    asJson: boolean,
    io: Io,
): Promise<number> {
    const schema = call.input as Schema | undefined;
    const input = parseArgs(argv, schema);

    const missing = missingRequired(input, schema);
    if (missing.length > 0) {
        io.err(`${call.domain} ${call.action} needs ${missing.map(flagFor).join(', ')}.\n`);
        io.err(`  ${call.description}`);
        for (const line of describeInput(schema)) io.err(line);
        return 2;
    }

    const { status, body } = await callContract(host, descriptor.base, call, input, ticket);

    if (status >= 400) {
        /**
         * A refusal is reported as a refusal.
         *
         * 401 with no ticket is *sign in*, and 401 with one is *this account may not*. Collapsing
         * them into "unauthorized" is how a person spends ten minutes re-entering a password that
         * was never the problem.
         */
        const message = isRecord(body) && typeof body['message'] === 'string' ? body['message'] : String(status);
        io.err(message);
        if (status === 401) {
            io.err(ticket === undefined
                ? `\nNot signed in. Try: mesh-serve --host ${host} login`
                : `\nSigned in as ${emailFor(host) ?? 'somebody'}, and this call needs more than that account has.`);
        }
        if (status === 403) io.err(`\n${call.gate?.level ?? 'A higher'} standing is required for ${call.key}.`);
        return 1;
    }

    io.out(asJson ? JSON.stringify(body, null, 2) : render(body));
    return 0;
}

/**
 * A result a person can read.
 *
 * `--json` is the escape hatch and is what anything reading this should pass. The default is for
 * eyes: an array of records becomes a table, one record becomes a list of fields, and anything else
 * is printed as it is.
 */
function render(body: unknown): string {
    if (body === undefined) return 'ok';
    if (Array.isArray(body)) {
        if (body.length === 0) return '(none)';
        if (!isRecord(body[0])) return body.map(String).join('\n');

        const columns = [...new Set(body.flatMap((row) => Object.keys(row as object)))]
            .filter((c) => c !== 'createdAt' && c !== 'updatedAt')
            .slice(0, 6);
        const widths = columns.map((c) => Math.max(c.length, ...body.map((row) => cell(row, c).length)));

        const line = (cells: readonly string[]): string =>
            cells.map((value, i) => value.padEnd(widths[i] ?? 0)).join('  ').trimEnd();

        return [
            line(columns),
            line(columns.map((_, i) => '─'.repeat(widths[i] ?? 0))),
            ...body.map((row) => line(columns.map((c) => cell(row, c)))),
        ].join('\n');
    }
    if (isRecord(body)) {
        const width = Math.max(...Object.keys(body).map((k) => k.length));
        return Object.entries(body).map(([k, v]) => `${k.padEnd(width)}  ${short(v)}`).join('\n');
    }
    return String(body);
}

/**
 * A cell is capped, because one long value ruins every row.
 *
 * `part.find` returns a `declaration` holding the whole part descriptor — several hundred characters
 * of JSON — and one of those columns pushed every other column off the screen, which made a working
 * table useless. `--json` is there for the whole value; a table is for comparing rows.
 */
const CELL = 32;

const cell = (row: unknown, column: string): string => {
    const value = short(isRecord(row) ? row[column] : undefined);
    return value.length <= CELL ? value : `${value.slice(0, CELL - 1)}…`;
};

const short = (value: unknown): string => {
    if (value === undefined || value === null) return '—';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
};

// ---------------------------------------------------------------------------- help

async function help(host: string | undefined, io: Io): Promise<number> {
    io.out('mesh-serve — a client for one site\n');
    io.out('  mesh-serve --host <site> <domain> <action> [--flags]\n');
    /**
     * Two groups, and the split is real rather than cosmetic.
     *
     * The first run *here* — a node, a checkout, a seed. The second talk to a site over HTTP and
     * need a host and a ticket. A person who cannot tell which is which ends up passing `--host` to
     * `node`, or wondering why `seed` does not appear in a site's command list.
     */
    io.out('  running a platform');
    io.out('    node      run a node: all services, one process');
    io.out('    seed      bring an empty cluster up to a hostname that answers');
    io.out('    publish   publish this checkout to a catalog');
    io.out('    client    generate a typed client from mesh.json');
    io.out('    dev       serve this part on a dev page\n');
    io.out('  talking to a site');
    io.out('    login     sign in and keep the ticket');
    io.out('    logout    forget it');
    io.out('    whoami    who this machine is signed in as');
    io.out('    set-password  set your own — and claim a first-boot account');
    io.out('    --json    print the raw result rather than a table\n');

    if (host === undefined) {
        io.out('Everything else comes from the site itself. Pass --host to see what one offers.');
        return 0;
    }

    const descriptor = await fetchDescriptor(host, ticketFor(host));
    const remembered = currentHost() === host ? ' (remembered)' : '';
    io.out(`${descriptor.application} at ${originOf(host)}${remembered} offers ${String(descriptor.calls.length)} call(s):\n`);

    if (descriptor.calls.length === 0) {
        io.out('  (none — this site grants nothing to this caller)\n');
        io.out(ticketFor(host) === undefined
            ? '  You are not signed in. A site reports what YOU may call, so signing in may show more.'
            : '  A site grants what its parts declare they consume. This one declares nothing.');
        return 0;
    }

    for (const domain of [...new Set(descriptor.calls.map((c) => c.domain))].sort()) {
        const actions = descriptor.calls.filter((c) => c.domain === domain);
        io.out(`  ${domain.padEnd(14)} ${actions.map((a) => a.action).join(', ')}`);
    }
    return 0;
}

async function domainHelp(descriptor: Descriptor, domain: string, io: Io): Promise<number> {
    const calls = descriptor.calls.filter((c) => c.domain === domain);
    if (calls.length === 0) {
        io.err(`${descriptor.application} exposes nothing called "${domain}".`);
        return 1;
    }
    for (const call of calls) {
        io.out(`  ${domain} ${call.action}${call.destructive === true ? '  (changes state)' : ''}`);
        io.out(`    ${call.description}`);
        for (const line of describeInput(call.input as Schema | undefined)) io.out(line);
        io.out('');
    }
    return 0;
}

async function unknown(descriptor: Descriptor, domain: string, action: string, io: Io): Promise<number> {
    /**
     * Absent and refused answer differently, on purpose.
     *
     * A descriptor is per-caller, so a command missing here may exist and be out of this account's
     * reach. Saying "no such command" to somebody who merely needs to sign in sends them looking for
     * a typo.
     */
    io.err(`${descriptor.application} does not offer "${domain} ${action}" to you.`);
    io.err(ticketFor(descriptor.application) === undefined
        ? '\nA site reports what YOU may call. If you are not signed in, signing in may reveal it.'
        : '\nIt may exist and be gated above this account.');
    return 1;
}

// ---------------------------------------------------------------------------- login

async function login(host: string, argv: readonly string[], io: Io): Promise<number> {
    /**
     * The descriptor is fetched **before** the password is asked for.
     *
     * Two reasons, and the second is the one that was wrong. It finds the api the same way every
     * other command does, so `login` cannot be the one place that insists on being told a port. And
     * it fails *before* somebody types a password into a prompt that was never going to work —
     * which is what "password: fetch failed" was.
     */
    const descriptor = await fetchDescriptor(host);
    const issue = descriptor.calls.find((c) => c.key === 'identity.ticket_issue');
    if (issue === undefined) {
        throw new CliError(
            `${descriptor.application} does not offer a way to sign in.`,
            'A site grants what its parts declare they consume. This one does not expose '
            + 'identity.ticket_issue, so there is no sign-in to reach.',
        );
    }

    const email = valueOf(argv, '--email') ?? await io.prompt('email: ', false);
    const password = await io.prompt('password: ', true);

    const { status, body } = await callContract(host, descriptor.base, issue, { email, password });

    if (status >= 400) {
        io.err(status === 401
            ? 'That email and password were not accepted.'
            : `Sign-in failed (${String(status)}).`);
        return 1;
    }

    const answer = body as { token?: string; ticket?: string } | undefined;
    const token = answer?.token ?? answer?.ticket;
    if (token === undefined) {
        io.err('Signed in, and the answer carried no ticket. That is a server bug, not yours.');
        return 1;
    }

    saveTicket(host, token, email);
    io.out(`Signed in to ${host} as ${email}.`);
    io.out(`Ticket stored in ${credentialsPath} (mode 0600).`);
    return 0;
}

/**
 * **Claim the account the platform made for itself.**
 *
 * A provisional account is refused everywhere except this, so without a command for it the first
 * boot produces a credential that can do nothing at all — including stop being provisional. This is
 * the door in that wall.
 *
 * It is a built-in rather than an ordinary derived command because a provisional caller's descriptor
 * is nearly empty by design: the one thing it may do would be the one thing the command list could
 * not show it.
 */
async function setPassword(
    host: string,
    descriptor: Descriptor,
    ticket: string | undefined,
    io: Io,
): Promise<number> {
    if (ticket === undefined) {
        io.err(`Not signed in to ${host}. Sign in first, then set a password.`);
        return 1;
    }

    const call = descriptor.calls.find((c) => c.key === 'identity.set_password');
    if (call === undefined) {
        io.err(`${descriptor.application} does not expose identity.set_password.`);
        return 1;
    }

    const password = await io.prompt('new password: ', true);
    const again = await io.prompt('again: ', true);
    if (password !== again) {
        io.err('Those did not match.');
        return 1;
    }

    const { status, body } = await callContract(host, descriptor.base, call, { password }, ticket);
    if (status >= 400) {
        io.err(isRecord(body) && typeof body['message'] === 'string' ? body['message'] : `Failed (${String(status)}).`);
        return 1;
    }

    const claimed = isRecord(body) && body['claimed'] === true;
    io.out(claimed
        ? 'Password set, and this account is claimed — it can do everything its roles allow now.'
        : 'Password set.');
    // The ticket was issued before the flag cleared, and the flag is read from the user on every
    // call, so it keeps working. Said out loud because "do I need to sign in again" is the next
    // thought.
    if (claimed) io.out('Your existing session still works.');
    return 0;
}

function whoami(host: string, io: Io): number {
    const email = emailFor(host);
    if (ticketFor(host) === undefined) {
        io.out(`Not signed in to ${host}.`);
        return 1;
    }
    io.out(`${email ?? '(unknown account)'} at ${host}`);
    // Said out loud, because this is the value that makes somebody deploy to production believing
    // they are on staging. A remembered host that is never printed is the dangerous version.
    if (currentHost() === host) io.out('(the remembered host — pass --host to use another)');
    return 0;
}

// ---------------------------------------------------------------------------- argv

const valueOf = (argv: readonly string[], flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
};

const withoutFlag = (argv: readonly string[], flag: string): readonly string[] => {
    const at = argv.indexOf(flag);
    return at === -1 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)];
};

const requireHost = (host: string | undefined): string => {
    if (host !== undefined) return host;
    throw new CliError(
        'Which site?',
        'Pass --host, or set MESH_HOST. Every command comes from a site: the api resolves one by the '
        + 'Host header, and what you may call depends on which site and which account.',
    );
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
