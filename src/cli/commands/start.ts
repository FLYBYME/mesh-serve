import type { Command as CommanderCommand } from 'commander';
import {
    BrokerModule,
    DatabaseModule,
    JSONSerializer, Logger, LogLevel, MeshApp,
    NetworkModule,
    PlacementRegistry, RegistryModule,
    z,
} from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import { BaseCommand } from '../core/BaseCommand.js';
import { ZodToCliMapper } from '../core/ZodToCliMapper.js';
import type { IServiceBroker } from '@flybyme/mesh';

import { resolveHandler } from '../../catalog/methods/resolveHandler.js';
import { createCorePartPlacement } from '../../catalog/methods/corePartPlacement.js';
import { CATALOG_DOMAINS } from '../../catalog/domains.js';
// Importing a contract module is what registers its contracts, which is where loadDomain reads
// them from.
import '../../catalog/contracts/repo.contract.js';
import '../../catalog/contracts/part.contract.js';
import '../../catalog/contracts/composition.contract.js';
import '../../catalog/contracts/artifact.contract.js';
import '../../catalog/contracts/release.contract.js';
import { CORE_PART_NAMES, type CorePartName } from '../../catalog/contracts/corePart.contract.js';

const LogLevelMap: Record<string, LogLevel> = {
    error: LogLevel.ERROR,
    warn: LogLevel.WARN,
    info: LogLevel.INFO,
    debug: LogLevel.DEBUG,
};

const startInputSchema = z.object({
    nodeID: z.string().default('node-1'),
    wsPort: z.coerce.number().default(6005).describe('Mesh peer transport port -- unrelated to the api/cdn http ports below'),
    apiPort: z.coerce.number().default(5005).describe('ApiService REST+SSE http port'),
    cdnPort: z.coerce.number().default(3123).describe('CdnService frontend http port'),
    db: z.string().optional().describe('Database name, e.g. "test-001" -- not a connection string; use MONGODB_URI for that'),
    logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('debug'),
    publicScheme: z.enum(['http', 'https']).optional().describe('Scheme used in every public-facing URL a site\'s HTML embeds (preconnect, CSP connect-src, the boot module\'s api field) -- defaults to https, the correct value whenever a reverse proxy fronts this node. Pass http only for an unproxied local node'),
    publicApiPort: z.coerce.number().optional().describe('Port appended to those same public-facing api URLs -- unset in production, where the public port is always the standard one for publicScheme. Needed only when apiPort is reached directly, unproxied (e.g. matching --apiPort for local dev)'),
    sharedKey: z.string().optional().describe('Shared secret required to join this node\'s mesh network (WSTransport\'s own authKey) -- also read from MESH_KEY if unset. Anything that can open a connection to --wsPort can otherwise call internal contracts directly, bypassing every api-level role/exposure check; required if --host binds to a non-loopback address'),
    host: z.string().default('127.0.0.1').describe('Interface to bind the mesh transport (--wsPort) to -- 0.0.0.0 (or a real address) for a multi-machine cluster, the default loopback for a single local node. Non-loopback requires --sharedKey'),
    bootstrapNode: z.string().optional().describe('ws:// URL of an existing node to join as a peer, e.g. ws://10.0.0.5:6005 -- omit to start a fresh, standalone cluster of one'),
    parts: z.string().optional().describe(`Core parts to run on this node, comma-separated (${CORE_PART_NAMES.join(', ')}) -- what this node is *for*. Only needed for parts that nothing will ever call into existence: an http listener (api, cdn) or a timer (queue) is never demand-loaded, because the demand arrives through the thing that isn't running yet. Everything else loads on first call and needs no flag. The usual second-node case is --parts api,cdn`),
});

export class StartCommand extends BaseCommand {
    public readonly name = 'start';
    public readonly description = 'Start a bare mesh node -- the catalog kernel only, nothing else. Load everything else with bootstrap, or serve.part.start/serve.corePart.load once joined.';

    public register(program: CommanderCommand): void {
        const sub = program.command(this.name).description(this.description);
        ZodToCliMapper.applyOptions(sub, startInputSchema);
        sub.action(async (opts: Record<string, unknown>) => {
            this.execute(startInputSchema.parse(ZodToCliMapper.parseOptions(opts, startInputSchema)));
        });
    }

    protected async execute(args: z.infer<typeof startInputSchema>): Promise<void> {
        const logger = new Logger(LogLevelMap[args.logLevel]);
        const serializer = new JSONSerializer();

        const node = new MeshApp({
            nodeID: args.nodeID,
            logger,
        });
        // ApiService and CdnService each read their own port from an env var at onStart time
        // (SERVER_PORT, API_PORT) -- set now, before anything actually loads them (bootstrap's
        // serve.corePart.load, or later a peer's own serve.part.start), not passed as constructor
        // args -- the process itself is the natural place for start-time CLI config to live,
        // regardless of when a given service actually gets loaded onto it.
        process.env.API_PORT = String(args.apiPort);
        process.env.SERVER_PORT = String(args.cdnPort);
        // Same pattern, and both left unset (CdnService's own defaults apply) unless given --
        // there is no correct universal default for either, only a correct default per deployment.
        if (args.publicScheme !== undefined) process.env.PUBLIC_SCHEME = args.publicScheme;
        if (args.publicApiPort !== undefined) process.env.PUBLIC_API_PORT = String(args.publicApiPort);

        const transport = new WSTransport(serializer, args.wsPort, args.host, { authKey: args.sharedKey });
        // PlacementRegistry, not the default Registry: a standalone part (one that registers
        // contracts directly rather than a whole ServiceModule) is only advertised to peers by a
        // registry that knows how to advertise a single contract. Found live -- with the default
        // Registry every core part loaded fine and was callable *on this node*, while another node
        // was told "no node in this mesh advertises domain identity".
        // No `ttl` override. It used to pass 5000, which is below the 15s presence interval, so in
        // any real multi-node cluster each peer was marked offline two thirds of the time, pruned,
        // rediscovered, and pruned again -- silently, since a single node never notices. Found the
        // first time two nodes ran together. The default (30000, two presences) is correct.
        node.use(new RegistryModule({ implementation: PlacementRegistry }));
        node.use(new NetworkModule({
            transports: [transport],
            ...(args.bootstrapNode !== undefined ? { bootstrapNodes: [args.bootstrapNode] } : {}),
        }));

        const dbConfig: { dbName?: string } = {};
        if (args.db) dbConfig.dbName = args.db;
        node.use(new DatabaseModule(dbConfig));

        node.use(new BrokerModule());

        await node.start();

        // The one thing this command still knows about by name -- the catalog owns
        // serve.part.start/serve.corePart.load, the mechanism that loads everything else,
        // including mesh-serve's own identity/cdn/hold/queue/api. Nothing else is mounted here.
        //
        // Loaded like any other part, from what its contracts declare. It just cannot load itself
        // through serve.corePart.load, because that contract is one of the ones being loaded --
        // so the list of its domains is written out here, and this is the only place in the
        // codebase that names a part's domains by hand.
        const broker = node.getProvider<IServiceBroker>('broker');
        for (const domain of CATALOG_DOMAINS) {
            await broker.loadDomain(domain, {}, { resolve: resolveHandler });
        }

        // With this, a bare node heals itself: the first call for a contract it doesn't have loads
        // the part implementing it, here, and then answers. That covers every `on-demand` contract,
        // so a node acquires whatever it is actually asked for with no load sequence of its own.
        broker.setPlacement(createCorePartPlacement(broker));

        // What demand-loading structurally cannot cover: a `long-running` or `interval` contract is
        // never *called* into existence. An http listener only receives a request once it is
        // listening, and a timer has no caller at all -- so for those, placement has to be a
        // decision rather than a reaction, and `--parts` is where an operator makes it. This is the
        // same decision `bootstrap` makes implicitly when claiming a fresh cluster; a node joining
        // an existing one has no equivalent moment, which is exactly the gap this fills.
        const parts = this.parseParts(args.parts);
        for (const name of parts) {
            const { domain } = await broker.call('serve.corePart.load', { name }, { nodeID: args.nodeID });
            this.logger.info(`Running "${domain}" on this node.`);
        }

        const summary = parts.length === 0
            ? 'catalog kernel only; everything else loads on demand'
            : `catalog kernel + ${parts.join(', ')}`;
        this.logger.info(`Node "${args.nodeID}" up (${summary}).`);
    }

    /**
     * Parsed and validated up front rather than per-load, so a typo fails before the node claims
     * ports and joins a cluster -- not three parts into starting.
     */
    private parseParts(raw: string | undefined): CorePartName[] {
        if (raw === undefined) return [];

        const names = raw.split(',').map((n) => n.trim()).filter((n) => n.length > 0);
        const unknown = names.filter((n) => !CORE_PART_NAMES.includes(n as CorePartName));
        if (unknown.length > 0) {
            throw new Error(`Unknown part(s) in --parts: ${unknown.join(', ')}. Known parts: ${CORE_PART_NAMES.join(', ')}.`);
        }
        return Array.from(new Set(names)) as CorePartName[];
    }
}
