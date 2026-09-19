/**
 * Claims a fresh node: creates the one real operator account, the "platform" organization it owns,
 * and the bootstrap api everything else logs into -- the run-once step between `mesh-serve start`
 * and being able to use the system through its api at all.
 *
 * Connects to the mesh network directly, the same way sync.ts does -- not through the api gateway,
 * on purpose: this step's whole job is to create the gate itself (the bootstrap api, its exposed
 * contracts, the account that can grant more exposure later), so there is nothing to authenticate
 * through yet. Everything after this point should go through the api instead, as that account.
 *
 * Refuses to run a second time: the "platform" organization existing at all means a node has already
 * been claimed. There is no way to reclaim or reset from here -- that's deliberate, the same way a
 * lost password isn't recoverable through this script either.
 *
 * If the node was started with --sharedKey (or MESH_KEY is set in this shell), the same value has to
 * be set here too -- WSTransport reads MESH_KEY automatically, so exporting it once covers both.
 *
 * Usage: npx tsx src/bootstrap.ts
 */
import readline from 'node:readline';
import {
    BrokerModule, JSONSerializer, Logger, LogLevel, MeshApp,
    NetworkModule, RegistryModule,
} from '@flybyme/mesh';
import type { IServiceBroker, IMeshApp, IServiceRegistry } from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import { hashPassword } from './identity/methods/hash.js';
import { ensureBootstrapApi } from './api/ensureBootstrapApi.js';

const ENTER_CHARS = new Set(['\n', '\r']);
const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const BACKSPACE_CHARS = new Set(['\b', String.fromCharCode(127)]);

const iterators = new WeakMap<readline.Interface, AsyncIterator<string>>();

function getIterator(rl: readline.Interface): AsyncIterator<string> {
    let it = iterators.get(rl);
    if (it === undefined) {
        it = rl[Symbol.asyncIterator]();
        iterators.set(rl, it);
    }
    return it;
}

/** Call right after createInterface, before any awaited work -- see questionHidden's own comment. */
function warm(rl: readline.Interface): void {
    getIterator(rl);
}

function nextLine(rl: readline.Interface): Promise<string> {
    return getIterator(rl).next().then((result) => result.value ?? '');
}

function question(rl: readline.Interface, query: string): Promise<string> {
    process.stdout.write(query);
    return nextLine(rl);
}

/**
 * A masked prompt (echoes "*" per keystroke), falling back to a plain question when stdin isn't a
 * real TTY (piped input). Copied from the interactive CLI's own prompt.ts (deleted along with the
 * rest of that CLI) rather than reinvented -- it already fixed two real, non-obvious bugs (piped
 * input losing buffered lines, a private-readline-method approach silently breaking non-TTY input)
 * that a fresh rewrite would risk reintroducing.
 */
function questionHidden(rl: readline.Interface, query: string): Promise<string> {
    if (!process.stdin.isTTY) {
        return question(rl, query);
    }

    return new Promise((resolve) => {
        process.stdout.write(query);
        rl.pause();

        const stdin = process.stdin;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf-8');

        let value = '';
        const cleanup = () => {
            stdin.setRawMode(false);
            stdin.removeListener('data', onData);
            rl.resume();
        };
        const onData = (char: string) => {
            if (ENTER_CHARS.has(char)) {
                cleanup();
                process.stdout.write('\n');
                resolve(value);
            } else if (char === CTRL_D) {
                cleanup();
                process.stdout.write('\n');
                resolve(value);
            } else if (char === CTRL_C) {
                cleanup();
                process.exit(130);
            } else if (BACKSPACE_CHARS.has(char)) {
                if (value.length > 0) {
                    value = value.slice(0, -1);
                    process.stdout.write('\b \b');
                }
            } else {
                value += char;
                process.stdout.write('*');
            }
        };

        stdin.on('data', onData);
    });
}

async function setup(): Promise<{ broker: IServiceBroker; registry: IServiceRegistry; mesh: IMeshApp }> {
    const logger = new Logger(LogLevel.WARN);
    const serializer = new JSONSerializer();

    const node = new MeshApp({ nodeID: 'bootstrap-1', logger });

    node.use(new RegistryModule({ ttl: 5000 }));
    node.use(new NetworkModule({
        bootstrapNodes: ['ws://127.0.0.1:6005'],
        transports: [new WSTransport(serializer, 0)],
    }));
    node.use(new BrokerModule());

    await node.start();

    const broker = node.getProvider<IServiceBroker>('broker');
    const registry = node.getProvider<IServiceRegistry>('registry');

    await registry.waitForNodes(2);

    return { broker, registry, mesh: node };
}

async function promptCredentials(): Promise<{ name: string; email: string; password: string }> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    warm(rl);
    try {
        const name = await question(rl, 'Name: ');
        const email = await question(rl, 'Email: ');

        let password: string;
        for (;;) {
            const first = await questionHidden(rl, 'Password (12+ characters): ');
            if (first.length < 12) {
                console.error('Too short -- 12 characters minimum. Try again.');
                continue;
            }
            const second = await questionHidden(rl, 'Confirm: ');
            if (first !== second) {
                console.error('Those did not match. Try again.');
                continue;
            }
            password = first;
            break;
        }

        return { name, email, password };
    } finally {
        rl.close();
    }
}

async function main(): Promise<void> {
    const { broker, mesh } = await setup();

    try {
        const existing = await broker.call('identity.organization.find_one', { query: { slug: 'platform' } });
        if (existing !== undefined) {
            console.error('Already claimed -- a "platform" organization already exists. This node has an operator; use "login" against its api instead.');
            process.exitCode = 1;
            return;
        }

        console.log('No operator yet. This creates the one real admin account for this node -- there is no undo.\n');
        const { name, email, password } = await promptCredentials();

        const passwordHash = await hashPassword(password);
        const user = await broker.call('identity.user.create', {
            email, displayName: name, passwordHash, roles: ['operator'], provisional: false,
        });

        const organization = await broker.call('identity.organization.create', {
            slug: 'platform', name: 'Platform', ownerId: user.id,
        });
        await broker.call('identity.membership.create', {
            userId: user.id, organizationId: organization.id, roleKey: 'owner', joinedAt: new Date(),
        }, { meta: { user: { id: user.id, tenant_id: '', organizationId: organization.id } } });

        await ensureBootstrapApi(broker);

        console.log(`\nClaimed. ${email} is the operator -- log in against the bootstrap api from here on.`);
    } finally {
        await mesh.stop();
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
});
