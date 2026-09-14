import {
    BrokerModule,
    DatabaseModule,
    JSONSerializer, Logger, LogLevel, MeshApp,
    NetworkModule,
    RegistryModule,
    z,
    type IServiceBroker,
    type IServiceRegistry
} from '@flybyme/mesh';
import type { MetaCommand } from '../metaCommand.js';
import { WSTransport } from '@flybyme/mesh/node';
import { IdentityService } from '../../identity/identity.service.js';
import { CdnService } from '../../cdn/cdn.service.js';
import { CatalogService } from '../../catalog/catalog.service.js';
import { ApiService } from '../../api/api.service.js';

const LogLevelMap: Record<string, LogLevel> = {
    error: LogLevel.ERROR,
    warn: LogLevel.WARN,
    info: LogLevel.INFO,
    debug: LogLevel.DEBUG,
};

/**
 * Start mesh node with all services running.
 */

const startInputSchema = z.object({
    nodeID: z.string().default('node-1'),
    wsPort: z.coerce.number().default(6005).describe('Mesh peer transport port -- unrelated to the api/cdn http ports below'),
    apiPort: z.coerce.number().default(5005).describe('ApiService REST+SSE http port'),
    cdnPort: z.coerce.number().default(3123).describe('CdnService frontend http port'),
    db: z.string().optional(),
    logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('debug'),
});

export const startCommand: MetaCommand<z.infer<typeof startInputSchema>> = {
    name: 'start',
    description: 'Start mesh node with all services running',
    input: startInputSchema,
    async run(args) {
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

        const transport = new WSTransport(serializer, args.wsPort);
        node.use(new RegistryModule({ ttl: 5000 })); // Short TTL for faster repro
        node.use(new NetworkModule({ transports: [transport] }));

        const dbConfig: { uri?: string } = {};
        if (args.db) dbConfig.uri = args.db;
        node.use(new DatabaseModule(dbConfig));

        node.use(new BrokerModule());


        await node.registerModule(new IdentityService());
        await node.registerModule(new CdnService());
        await node.registerModule(new CatalogService());
        await node.registerModule(new ApiService());

        await node.start();

        const broker = node.getProvider<IServiceBroker>('broker');
        const registry = node.getProvider<IServiceRegistry>('registry');

        //await registry.waitForService('serve.api', 5000);
        console.log('All services started successfully');

    },
};
