import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command as CommanderCommand } from 'commander';
import {
    BrokerModule, JSONSerializer, Logger, LogLevel, MeshApp,
    NetworkModule, RegistryModule, z,
} from '@flybyme/mesh';
import type { IServiceBroker, IMeshApp, IServiceRegistry } from '@flybyme/mesh';
import { WSTransport } from '@flybyme/mesh/node';

import { BaseCommand } from '../core/BaseCommand.js';
import { ZodToCliMapper } from '../core/ZodToCliMapper.js';

const generateInputSchema = z.object({
    api: z.string().describe('The serve.api id to render a typed client for'),
    out: z.string().default('./generated/api.ts').describe('Where to write the generated client'),
    bootstrapNode: z.string().default('ws://127.0.0.1:6005').describe('ws:// URL of a running node to connect through'),
    sharedKey: z.string().optional().describe('Shared secret that node\'s mesh network requires -- also read from MESH_KEY if unset'),
});

/**
 * Renders one api's full current typed client, straight from the mesh -- the same
 * `serve.api.generateClient` contract the api itself exposes over HTTP, called here directly
 * instead, the same way `bootstrap` reaches the mesh: no api gateway, no login, no session. There is
 * no client-side narrowing file to go stale against the server's own state -- this always renders
 * exactly what the api currently exposes.
 *
 * The interactive CLI's own `generate` (deleted along with `login`/`session`/`client.ts`) did this
 * over HTTP as a signed-in caller. Rebuilt here without any of that: an operator running this has
 * direct mesh access already (the same trust `bootstrap` assumes), so there is nothing to sign in
 * to.
 */
export class GenerateCommand extends BaseCommand {
    public readonly name = 'generate';
    public readonly description = 'Render an api\'s full current typed client, connecting to the mesh directly';

    public register(program: CommanderCommand): void {
        const sub = program.command(this.name).description(this.description);
        ZodToCliMapper.applyOptions(sub, generateInputSchema);
        sub.action(async (opts: Record<string, unknown>) => {
            this.execute(generateInputSchema.parse(ZodToCliMapper.parseOptions(opts, generateInputSchema)));
        });
    }

    private async connect(args: z.infer<typeof generateInputSchema>): Promise<{ broker: IServiceBroker; mesh: IMeshApp }> {
        const logger = new Logger(LogLevel.WARN);
        const serializer = new JSONSerializer();

        const node = new MeshApp({ nodeID: 'generate-1', logger });
        node.use(new RegistryModule({ ttl: 30000 }));
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

    protected async execute(args: z.infer<typeof generateInputSchema>): Promise<void> {
        const { broker, mesh } = await this.connect(args);
        try {
            const { source } = await broker.call('serve.api.generateClient', { apiId: args.api });
            await fs.mkdir(path.dirname(args.out), { recursive: true });
            await fs.writeFile(args.out, source);
            this.logger.info(`Wrote ${args.out} (${source.length} bytes).`);
        } finally {
            await mesh.stop();
        }
    }
}
