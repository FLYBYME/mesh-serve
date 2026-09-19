import type { Command as CommanderCommand } from 'commander';
import {
    BrokerModule,
    DatabaseModule,
    JSONSerializer, Logger, LogLevel, MeshApp,
    NetworkModule,
    RegistryModule,
    z,
} from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import { BaseCommand } from '../core/BaseCommand.js';
import { ZodToCliMapper } from '../core/ZodToCliMapper.js';
import { IdentityService } from '../../identity/identity.service.js';
import { CdnService } from '../../cdn/cdn.service.js';
import { CatalogService } from '../../catalog/catalog.service.js';
import { HoldService } from '../../hold/hold.service.js';
import { QueueService } from '../../queue/queue.service.js';
import { ApiService } from '../../api/api.service.js';

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
});

export class StartCommand extends BaseCommand {
    public readonly name = 'start';
    public readonly description = 'Start mesh node with all services running';

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

        logger.info('[Repro] Initializing Stable Provider (Node 1)...');
        const node = new MeshApp({
            nodeID: args.nodeID,
            logger,
        });
        // ApiService and CdnService each read their own port from an env var at onStart time
        // (SERVER_PORT, API_PORT) -- set before registering them, not passed as constructor args.
        process.env.API_PORT = String(args.apiPort);
        process.env.SERVER_PORT = String(args.cdnPort);
        // Same pattern, and both left unset (CdnService's own defaults apply) unless given --
        // there is no correct universal default for either, only a correct default per deployment.
        if (args.publicScheme !== undefined) process.env.PUBLIC_SCHEME = args.publicScheme;
        if (args.publicApiPort !== undefined) process.env.PUBLIC_API_PORT = String(args.publicApiPort);

        const transport = new WSTransport(serializer, args.wsPort, args.host, { authKey: args.sharedKey });
        node.use(new RegistryModule({ ttl: 5000 })); // Short TTL for faster repro
        node.use(new NetworkModule({
            transports: [transport],
            ...(args.bootstrapNode !== undefined ? { bootstrapNodes: [args.bootstrapNode] } : {}),
        }));

        const dbConfig: { dbName?: string } = {};
        if (args.db) dbConfig.dbName = args.db;
        node.use(new DatabaseModule(dbConfig));

        node.use(new BrokerModule());

        await node.registerModule(new IdentityService());
        await node.registerModule(new CdnService());
        await node.registerModule(new CatalogService());
        await node.registerModule(new HoldService());
        await node.registerModule(new QueueService());
        await node.registerModule(new ApiService());

        await node.start();

        this.logger.info('All services started successfully');
    }
}
