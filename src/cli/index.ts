#!/usr/bin/env node
import { Command } from 'commander';

import { StartCommand } from './commands/start.js';
import { BootstrapCommand } from './commands/bootstrap.js';
import { GenerateCommand } from './commands/generate.js';
import { SyncCommand } from './commands/sync.js';
import { LoginCommand } from './commands/login.js';
import { SwitchCommand } from './commands/switch.js';
import { ApisCommand } from './commands/apis.js';
import { WatchCommand } from './commands/watch.js';
import { registerDiscoveredCommands } from './core/dynamicCommands.js';
import { patchSession, readSession, toCachedDescriptor, type Session } from './core/session.js';
import { describeApi } from './core/apiClient.js';

/**
 * The one entry point behind the `mesh-serve` binary.
 *
 * Two kinds of command, and the split is the whole design. **Built-ins** are about this machine and
 * this cluster: `start` boots a node, `bootstrap` claims one, `generate` renders a typed client for
 * a repo checked out on disk, `sync` applies a site spec, and `login`/`switch` decide who and where.
 * They exist regardless of what the CLI is pointed at. **Discovered** commands come from whichever
 * api `switch` selected, read from its own `_describe`.
 *
 * `bootstrap` is the only thing here that touches the mesh network directly, because its whole job
 * is to create the gate everything else goes through -- there is nothing to authenticate against
 * yet. Every other built-in, including `generate` and `sync`, is an ordinary api client using the
 * currently signed-in operator's own ticket, subject to the same `serve.expose` rows and permission
 * floors as a browser. `sync` used to connect to the mesh directly on the reasoning that it was
 * many api-shaped operations in one session rather than a login plus a round trip per step -- that
 * was the same shortcut `syncAdmin` and a raw `serve.artifact.build` were, before those were found
 * and removed, just at the level of the whole connection instead of one call. `sync.ts` is, in
 * effect, the specification for what a fuller api client automates; it is not a reason to skip
 * being one. That is deliberate: it makes an incomplete api impossible not to notice, because these
 * commands cannot route around it either.
 */
function buildProgram(session: Session, writeErr: (text: string) => void): Command {
    const program = new Command();
    program
        .name('mesh-serve')
        .description('mesh-serve -- start a node, claim a fresh one, or work against an api.')
        .configureOutput({ writeErr })
        .exitOverride();

    new StartCommand().register(program);
    new BootstrapCommand().register(program);
    new GenerateCommand().register(program);
    new SyncCommand().register(program);
    new LoginCommand().register(program);
    new SwitchCommand().register(program);
    new ApisCommand().register(program);
    new WatchCommand().register(program);
    // Last: a discovered command must never shadow a built-in.
    registerDiscoveredCommands(program, session);
    return program;
}

function commanderCode(err: unknown): string | undefined {
    return typeof err === 'object' && err !== null && 'code' in err && typeof (err as { code: unknown }).code === 'string'
        ? (err as { code: string }).code
        : undefined;
}

async function refreshed(session: Session): Promise<Session | undefined> {
    if (session.apiUrl === undefined) return undefined;
    try {
        return await patchSession({ descriptor: toCachedDescriptor(await describeApi(session.apiUrl)) });
    } catch {
        return undefined; // offline or unreachable: the cache stands
    }
}

async function main(): Promise<void> {
    let session = await readSession();
    const wanted = process.argv[2];
    const isApiCommand = (s: Session): boolean => wanted !== undefined && (s.descriptor?.calls.some((c) => c.key === wanted) ?? false);

    // The cached surface can be older than the api in two ways, and each read as a user error until
    // `switch` was run by hand: a command exposed since (storagePool.create -> "unknown command"),
    // and a field added to a known one (certProvider.update --default -> "unknown option").
    // The first is caught before parsing, the second on the way out; either way the api's surface
    // is read once, and the command runs against it.
    if (wanted !== undefined && wanted.includes('.') && !isApiCommand(session)) {
        session = (await refreshed(session)) ?? session;
    }

    let errors = '';
    try {
        await buildProgram(session, (text) => { errors += text; }).parseAsync(process.argv.slice(2), { from: 'user' });
        process.stderr.write(errors);
        return;
    } catch (err) {
        const code = commanderCode(err);
        if (code === 'commander.unknownOption' && isApiCommand(session)) {
            const fresh = await refreshed(session);
            if (fresh !== undefined) {
                process.exitCode = undefined;
                return run(buildProgram(fresh, (text) => process.stderr.write(text)));
            }
        }
        process.stderr.write(errors);
        if (code === undefined || !code.startsWith('commander.')) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exitCode = 1;
        }
    }
}

async function run(program: Command): Promise<void> {
    try {
        await program.parseAsync(process.argv.slice(2), { from: 'user' });
    } catch (err) {
        const code = commanderCode(err);
        if (code === undefined || !code.startsWith('commander.')) {
            console.error(err instanceof Error ? err.message : String(err));
            process.exitCode = 1;
        }
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
