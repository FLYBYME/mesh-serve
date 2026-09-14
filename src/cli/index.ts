import { startRepl } from './repl.js';
import { runOneShot } from './oneShot.js';
import { restClient } from './client.js';
import { createSession } from './session.js';
import { ensureDescriptor } from './ensureDescriptor.js';
import { dispatchMeta } from './dispatchMeta.js';
import { metaCommands, findMetaCommand } from './commands/index.js';
import type { MetaCommandContext } from './metaCommand.js';

const USAGE = `mesh-serve -- dynamic client of an already-running api server.

Its domain.action command tree isn't hand-written -- it comes back from GET /api/_describe on
--host and is cached in ~/.mesh-serve/session.json, so it isn't re-fetched on every invocation.
Run "refresh" after a site's exposure changes, or "switch" to point at a different host.

Usage:
  mesh-serve <domain> <action> [--flag value...] [--host h] [--token t]   one-shot
  mesh-serve <meta-command> [args...] [--host h]                         login, switch, start, ...
  mesh-serve [repl] [--host h] [--token t]                                interactive

Options:
  --host <apiHost>   Api host for this invocation (default: last used, or localhost:5005)
  --token <token>    Bearer credential for this invocation (default: last login)
  -h, --help         This message, plus the live command list if --host is reachable
`;

async function printHelp(ctx: MetaCommandContext): Promise<void> {
    console.log(USAGE);

    console.log('Meta commands:');
    for (const command of ctx.commands) {
        const names = [command.name, ...(command.aliases ?? [])].join('/');
        console.log(`  ${names.padEnd(12)} ${command.description}`);
    }
    console.log('');

    let descriptor;
    try {
        descriptor = await ensureDescriptor(ctx.session, ctx.client);
    } catch (err) {
        console.log(`(No server reachable at "${ctx.session.apiHost}" -- "start" one, or "switch" host. ${err instanceof Error ? err.message : String(err)})`);
        return;
    }

    console.log(`Commands at ${ctx.session.apiHost} (${descriptor.calls.length}):`);
    const byDomain = new Map<string, typeof descriptor.calls[number][]>();
    for (const call of descriptor.calls) {
        const list = byDomain.get(call.domain) ?? [];
        list.push(call);
        byDomain.set(call.domain, list);
    }
    for (const [domain, calls] of [...byDomain].sort(([a], [b]) => a.localeCompare(b))) {
        console.log(`  ${domain}`);
        for (const call of calls) {
            console.log(`    ${call.action.padEnd(16)} ${call.method.padEnd(6)} ${call.description}`);
        }
    }
}

/**
 * The one entry point behind the `mesh-serve` command: a dynamic client of an already-running
 * ApiService, never a mesh peer, plus a fixed set of meta commands (login, switch, start...) that
 * exist independently of any server. Meta commands are checked before anything ever tries to reach
 * a server, so "mesh-serve start" (which boots one) and "mesh-serve login <token>" both work without
 * requiring a reachable api first.
 */
async function main(): Promise<void> {
    const argv = process.argv.slice(2);

    let apiHostFlag: string | undefined;
    let tokenFlag: string | undefined;
    let help = false;
    const rest: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--host') {
            apiHostFlag = argv[++i];
        } else if (arg === '--token') {
            tokenFlag = argv[++i];
        } else if (arg === '-h' || arg === '--help') {
            help = true;
        } else if (arg !== undefined) {
            rest.push(arg);
        }
    }

    const session = await createSession(apiHostFlag);
    if (tokenFlag !== undefined) {
        session.credential = tokenFlag;
    }

    const ctx: MetaCommandContext = { session, commands: metaCommands, client: restClient };

    if (help) {
        await printHelp(ctx);
        return;
    }

    if (rest.length === 0 || rest[0] === 'repl') {
        await startRepl(session);
        return;
    }

    const [name, ...args] = rest;
    const meta = name !== undefined ? findMetaCommand(name) : undefined;

    if (meta !== undefined) {
        await dispatchMeta(meta, args, ctx);
        return;
    }

    await runOneShot(session, rest);
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
