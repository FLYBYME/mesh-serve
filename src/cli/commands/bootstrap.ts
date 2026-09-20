import readline from 'node:readline';
import type { Command as CommanderCommand } from 'commander';
import {
    BrokerModule, JSONSerializer, Logger, LogLevel, MeshApp,
    NetworkModule, RegistryModule, z,
} from '@flybyme/mesh';
import type { IServiceBroker, IMeshApp, IServiceRegistry } from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import { BaseCommand } from '../core/BaseCommand.js';
import { ZodToCliMapper } from '../core/ZodToCliMapper.js';
import { question, questionHidden } from '../prompt.js';
import { hashPassword } from '../../identity/methods/hash.js';
import { ensureBootstrapApi, BOOTSTRAP_API_HOST } from '../../api/ensureBootstrapApi.js';
import { CORE_PART_NAMES } from '../../catalog/contracts/corePart.contract.js';

const bootstrapInputSchema = z.object({
    bootstrapNode: z.string().default('ws://127.0.0.1:6005').describe('ws:// URL of the running node to claim'),
    sharedKey: z.string().optional().describe('Shared secret that node\'s mesh network requires (--sharedKey on its own start) -- also read from MESH_KEY if unset'),
    name: z.string().optional().describe('Operator display name -- pass it (with --email) to claim without the wizard'),
    email: z.string().optional().describe('Operator email; the password comes from MESH_BOOTSTRAP_PASSWORD, never a flag'),
    orgName: z.string().optional().describe('Organization display name (default "Platform"); its slug is always "platform"'),
    apiHost: z.string().optional().describe(`Bootstrap api hostname (default "${BOOTSTRAP_API_HOST}")`),
});

/**
 * The claim itself, however it was gathered. Separating this from *asking* is what makes the
 * non-interactive path a different source for the same four values rather than a second code path
 * that can drift from the wizard.
 */
interface Claim {
    readonly displayName: string;
    readonly email: string;
    readonly password: string;
    readonly orgName: string;
    readonly apiHost: string;
}

/**
 * The password is taken from the environment, never a flag. A CLI option lands in shell history and
 * in the process table of every other user on the machine; an env var does neither, and is what CI
 * and deploy tooling already expect to pass a secret through.
 */
const PASSWORD_ENV = 'MESH_BOOTSTRAP_PASSWORD';

/**
 * Claims a fresh node: creates the one real operator account, an organization it owns, and the
 * bootstrap api everything else logs into -- the run-once step between `mesh-serve start` and being
 * able to use the system through its api at all.
 *
 * Connects to the mesh network directly, not through the api gateway, on purpose: this step's whole
 * job is to create the gate itself (the bootstrap api, its exposed contracts, the account that can
 * grant more exposure later), so there is nothing to authenticate through yet. Everything after this
 * point should go through the api instead, as that account.
 *
 * Refuses to run a second time: an existing "platform" organization means the node has already been
 * claimed. There is no reclaim/reset path from here, deliberately -- the same as a lost password.
 */
export class BootstrapCommand extends BaseCommand {
    public readonly name = 'bootstrap';
    public readonly description = 'Claim a fresh node: create the operator account, its organization, the bootstrap api, and any custom roles';

    public register(program: CommanderCommand): void {
        const sub = program.command(this.name).description(this.description);
        ZodToCliMapper.applyOptions(sub, bootstrapInputSchema);
        sub.action(async (opts: Record<string, unknown>) => {
            this.execute(bootstrapInputSchema.parse(ZodToCliMapper.parseOptions(opts, bootstrapInputSchema)));
        });
    }

    private async setup(args: z.infer<typeof bootstrapInputSchema>): Promise<{ broker: IServiceBroker; mesh: IMeshApp }> {
        const logger = new Logger(LogLevel.WARN);
        const serializer = new JSONSerializer();

        // Unique per process, not the literal 'bootstrap-1' this used to be. A nodeID is an
        // identity: while one process holds it, a second claiming it is refused by the target node
        // (WSTransport's DUPLICATE_NODE_ID_CLOSE). This wizard is interactive, so abandoning it
        // half-filled and running it again is the *normal* thing to do -- and with a fixed id that
        // second run failed, for as long as the first process lived, as "Timeout: only 1/2 nodes
        // found". Nothing here needs a stable id: this peer exists for one run and answers no calls.
        const node = new MeshApp({ nodeID: `bootstrap-${String(process.pid)}`, logger });
        // Long TTL, deliberately -- unlike sync.ts (fully unattended) or start.ts's own server (always
        // heartbeating itself), this side of the connection goes quiet for as long as a real person
        // takes to fill out this wizard. 5000ms let the target node's registry entry go stale mid-way,
        // failing the very next call ("no node advertises domain identity") with everything already
        // typed in -- found live, on a real terminal, filling the form out at normal human speed.
        node.use(new RegistryModule({ ttl: 300000 }));
        node.use(new NetworkModule({
            bootstrapNodes: [args.bootstrapNode],
            transports: [new WSTransport(serializer, 0, undefined, { authKey: args.sharedKey })],
        }));
        node.use(new BrokerModule());

        await node.start();

        const broker = node.getProvider<IServiceBroker>('broker');
        const registry = node.getProvider<IServiceRegistry>('registry');
        await registry.waitForNodes(2);

        return { broker, mesh: node };
    }

    /**
     * `start` brings up the catalog kernel and nothing else, so on a fresh node none of
     * identity/cdn/hold/queue/api exists yet -- there is literally nothing to claim an operator
     * against until something loads them. This is that something, and bootstrap is the right (and
     * on a fresh cluster, only) place for it: the one step that reaches into the mesh network
     * directly rather than through the api gates, precisely because the gates don't exist yet.
     *
     * Each call executes *in-process on whichever node actually runs serve.catalog* -- loading a
     * module is inherently local (`require()` + `broker.loadDomain`), so this can't be done by the bootstrap
     * process itself reaching in; it has to be a contract the target node executes on its own
     * behalf. `serve.corePart.load` is exactly that.
     *
     * Already-loaded parts are skipped rather than fatal: re-running bootstrap against a node
     * that's partly up should converge, not refuse.
     */
    private async loadCoreParts(broker: IServiceBroker): Promise<void> {
        for (const name of CORE_PART_NAMES) {
            try {
                const { domain, nodeID } = await broker.call('serve.corePart.load', { name });
                console.log(`Loaded "${domain}" on ${nodeID}.`);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (/already running/i.test(message)) {
                    console.log(`"${name}" was already running -- skipping.`);
                    continue;
                }
                throw err;
            }
        }
    }

    /**
     * The claim as the flags and environment describe it, or undefined when nothing was supplied
     * and the wizard should run. Half-supplied is an error, not a partial wizard: a run that
     * silently prompts for the one thing a deploy script forgot would hang forever in CI.
     */
    private claimFromArgs(args: z.infer<typeof bootstrapInputSchema>): Claim | undefined {
        const password = process.env[PASSWORD_ENV];
        if (args.email === undefined && args.name === undefined && password === undefined) return undefined;

        const missing: string[] = [];
        if (args.name === undefined) missing.push('--name');
        if (args.email === undefined) missing.push('--email');
        if (password === undefined) missing.push(PASSWORD_ENV);
        if (missing.length > 0) {
            throw new Error(`Claiming without the wizard needs all of: --name, --email, ${PASSWORD_ENV}. Missing: ${missing.join(', ')}.`);
        }
        // Same floor the wizard enforces. Checked here too, because the wizard's loop is the only
        // other thing that ever enforced it and this path does not go through it.
        if (password!.length < 12) {
            throw new Error(`${PASSWORD_ENV} is too short -- 12 characters minimum.`);
        }

        return {
            displayName: args.name!,
            email: args.email!,
            password: password!,
            orgName: args.orgName ?? 'Platform',
            apiHost: args.apiHost ?? BOOTSTRAP_API_HOST,
        };
    }

    /**
     * The claim itself: the operator, the organization owning everything, their membership, and the
     * api the rest of the world comes in through. One implementation, whether the values were typed
     * or passed -- so the two entry points cannot diverge on what claiming means.
     */
    private async claim(broker: IServiceBroker, claim: Claim): Promise<void> {
        const passwordHash = await hashPassword(claim.password);
        const user = await broker.call('identity.user.create', {
            email: claim.email, displayName: claim.displayName, passwordHash,
            roles: ['operator'], provisional: false,
        });

        // slug stays the literal 'platform' regardless of the display name -- ensureBootstrapApi
        // (and the api's own every-boot check) look this collection up by that exact slug, not by
        // name. Only the name is the operator's own.
        //
        // No manual membership.create after this: identity.organization.create's own `after`
        // hook now creates the owner's membership itself (organization.contract.ts) -- the same
        // gap this file used to paper over by hand is now closed for every caller, not just this
        // one, which is what let a live operator onboarding a *second* tenant through the api hit
        // it too (nothing there could construct the meta override this file's own manual call
        // relied on).
        const organization = await broker.call('identity.organization.create', {
            slug: 'platform', name: claim.orgName, ownerId: user.id,
        });

        await ensureBootstrapApi(broker, claim.apiHost);

        console.log(`\nClaimed. ${claim.email} is the operator, owner of "${organization.name}" -- api on "${claim.apiHost}".\n`);
    }

    private async addCustomRoles(rl: readline.Interface, broker: IServiceBroker): Promise<void> {
        for (;;) {
            const add = await question(rl, 'Add a custom role? [y/N]: ');
            if (!/^y/i.test(add.trim())) return;

            const key = (await question(rl, '  Role key (e.g. "support"): ')).trim();
            const name = (await question(rl, '  Display name: ')).trim();
            const scopeRaw = (await question(rl, '  Scope, organization or global [organization]: ')).trim();
            const scope = scopeRaw === 'global' ? 'global' : 'organization';
            const permissions = (await question(rl, '  Permissions, comma-separated (e.g. "serve.repo.*,identity.whoami"): '))
                .split(',').map((s) => s.trim()).filter((s) => s.length > 0);
            const inherits = (await question(rl, '  Inherits, comma-separated role keys, blank for none: '))
                .split(',').map((s) => s.trim()).filter((s) => s.length > 0);

            try {
                const result = await broker.call('identity.role.upsert', { key, name, scope, builtin: false, inherits, permissions });
                console.log(`  Role "${result.key}" ${result.created ? 'created' : 'updated'}.`);
            } catch (err) {
                console.error(`  ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }

    protected async execute(args: z.infer<typeof bootstrapInputSchema>): Promise<void> {
        const { broker, mesh } = await this.setup(args);

        try {
            // Before anything else: the target node is a bare catalog kernel until this runs, so
            // every identity.*/serve.api.* call below would otherwise fail with "no node advertises
            // domain identity".
            await this.loadCoreParts(broker);

            // The builtin roles, seeded once, deliberately -- not by every node that happens to
            // load the identity part. It writes shared cluster state, and loading is per node, so
            // five nodes booting would mean five racing seed loops. Idempotent regardless, and
            // needed before anything below: nothing can be granted `operator`/`owner` until those
            // roles exist.
            const roles = await broker.call('identity.role.ensureBuiltins', {});
            if (roles.created.length > 0) console.log(`Seeded builtin roles: ${roles.created.join(', ')}.`);

            const existing = await broker.call('identity.organization.find_one', { query: { slug: 'platform' } });
            if (existing !== undefined) {
                this.logger.error('Already claimed -- a "platform" organization already exists. This node has an operator; log in against its api instead.');
                process.exitCode = 1;
                return;
            }

            console.log('No operator yet. This creates the one real admin account for this node -- there is no undo.\n');

            // Non-interactive when told who the operator is. Nothing about claiming a node needs a
            // human present -- only *deciding* does -- and with no such path, a fresh cluster could
            // not be brought up by CI, by a deploy script, or by a test, which is also why nothing
            // ever exercised this command end to end.
            const supplied = this.claimFromArgs(args);
            if (supplied !== undefined) {
                await this.claim(broker, supplied);
                console.log('\nDone. Log in against the bootstrap api from here on.');
                return;
            }

            if (process.stdin.isTTY !== true) {
                this.logger.error(`Not a terminal, and no --email/--name given. Pass --name, --email and ${PASSWORD_ENV} to claim without the wizard.`);
                this.logger.error('(Piping answers in does not work: readline delivers a file\'s lines in one burst and the unawaited ones are dropped.)');
                process.exitCode = 1;
                return;
            }

            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            try {
                const displayName = await question(rl, 'Name: ');
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

                const orgNameRaw = await question(rl, 'Organization name [Platform]: ');
                const orgName = orgNameRaw.trim().length > 0 ? orgNameRaw.trim() : 'Platform';

                const apiHostRaw = await question(rl, `Bootstrap api hostname [${BOOTSTRAP_API_HOST}]: `);
                const apiHost = apiHostRaw.trim().length > 0 ? apiHostRaw.trim() : BOOTSTRAP_API_HOST;

                await this.claim(broker, { displayName, email, password, orgName, apiHost });

                await this.addCustomRoles(rl, broker);

                console.log('\nDone. Log in against the bootstrap api from here on.');
            } finally {
                rl.close();
            }
        } finally {
            await mesh.stop();
        }
    }
}
