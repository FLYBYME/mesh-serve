// GENERATED FILE - DO NOT EDIT
import { Command } from 'commander';
import { MeshApp, C, RegistryModule, NetworkModule, BrokerModule, JSONSerializer, Logger } from '@flybyme/mesh';
import { WSTransport, ZodToCliMapper } from '@flybyme/mesh/node';
import * as Contract_0 from '../../builder/contracts/artifact.contract.js';
import * as Contract_1 from '../../catalog/contracts/part.contract.js';
import * as Contract_2 from '../../cdn/contracts/site.contract.js';
import * as Contract_3 from '../../identity/contracts/identity.contract.js';

async function executeCommand(toolName: string, args: Record<string, unknown>, contract: any, options: any) {
    const logger = new Logger(3);
    const nodeId = options.nodeId || `cli-${Math.random().toString(36).substring(2, 9)}`;
    const app = new MeshApp({ nodeID: nodeId, logger });
    const serializer = new JSONSerializer();
    const port = parseInt(options.port || '0', 10);
    const host = options.host || '0.0.0.0';
    const wsTransport = new WSTransport(serializer, port, host);
    
    const bootstrapStr = options.bootstrap || 'ws://127.0.0.1:5005';
    app.use(new RegistryModule());
    app.use(new NetworkModule({
        port,
        transports: [wsTransport],
        bootstrapNodes: bootstrapStr ? bootstrapStr.split(',').map((s: string) => s.trim()) : []
    }));
    app.use(new BrokerModule());

    await app.start();
    
    if (bootstrapStr) {
        // Wait for the actual tool to become resolvable (event-driven, via
        // Registry's own 'changed' event -- see Registry.waitForTool) instead of
        // a blind fixed sleep. A hardcoded 2000ms guess raced peer-exchange sync
        // on any connection slower than a fast local/LAN path (found for real over
        // a higher-latency tunnel: 'Local tool not found' with an empty registry,
        // even though the peer had genuinely connected -- PEX just hadn't finished
        // propagating yet). 15s ceiling matches waitForTool's own default.
        try {
            await app.registry.waitForTool(toolName, 15000);
        } catch {
            // Let the real call fail with its own real error below rather than
            // failing here on a timeout that may itself be stale.
        }
    }

    try {
        console.log(C.dim + `Executing ${toolName}...` + C.reset);
        const res = await app.call(toolName as any, ZodToCliMapper.parseOptions(args, contract.inputSchema) as any, { timeout: 300000 });
        console.log(contract.print(res));
    } finally {
        await app.stop();
    }
}

export function registerGeneratedCommands(program: Command) {
    const builder = program.command('builder').description('builder tools');
    const cmd_builder_buildStartContract_build_start = builder.command('build_start').description(`Build one published version of a part into its artifact.`);
    cmd_builder_buildStartContract_build_start.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('builder.build_start', o, Contract_0.buildStartContract, cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_builder_buildStartContract_build_start, Contract_0.buildStartContract.inputSchema);
    const cmd_builder_getArtifactContract_get_artifact = builder.command('get_artifact').description(`Fetch one artifact by its content digest.`);
    cmd_builder_getArtifactContract_get_artifact.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('builder.get_artifact', o, Contract_0.getArtifactContract, cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_builder_getArtifactContract_get_artifact, Contract_0.getArtifactContract.inputSchema);
    const cmd_builder_artifactBlobContract_artifact_blob = builder.command('artifact_blob').description(`Where to download one file of an artifact, by its content digest.`);
    cmd_builder_artifactBlobContract_artifact_blob.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('builder.artifact_blob', o, Contract_0.artifactBlobContract, cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_builder_artifactBlobContract_artifact_blob, Contract_0.artifactBlobContract.inputSchema);
    const artifact = program.command('artifact').description('artifact tools');
    const cmd_artifact_artifactCrud_create_create = artifact.command('create').description(`CRUD create for artifact (artifactCrud)`);
    cmd_artifact_artifactCrud_create_create.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('artifact.create', o, Contract_0.artifactCrud['create'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_artifact_artifactCrud_create_create, Contract_0.artifactCrud['create'].inputSchema);
    const cmd_artifact_artifactCrud_find_find = artifact.command('find').description(`CRUD find for artifact (artifactCrud)`);
    cmd_artifact_artifactCrud_find_find.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('artifact.find', o, Contract_0.artifactCrud['find'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_artifact_artifactCrud_find_find, Contract_0.artifactCrud['find'].inputSchema);
    const cmd_artifact_artifactCrud_findOne_find_one = artifact.command('find_one').description(`CRUD findOne for artifact (artifactCrud)`);
    cmd_artifact_artifactCrud_findOne_find_one.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('artifact.find_one', o, Contract_0.artifactCrud['findOne'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_artifact_artifactCrud_findOne_find_one, Contract_0.artifactCrud['findOne'].inputSchema);
    const cmd_artifact_artifactCrud_count_count = artifact.command('count').description(`CRUD count for artifact (artifactCrud)`);
    cmd_artifact_artifactCrud_count_count.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('artifact.count', o, Contract_0.artifactCrud['count'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_artifact_artifactCrud_count_count, Contract_0.artifactCrud['count'].inputSchema);
    const cmd_artifact_artifactCrud_get_get = artifact.command('get').description(`CRUD get for artifact (artifactCrud)`);
    cmd_artifact_artifactCrud_get_get.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('artifact.get', o, Contract_0.artifactCrud['get'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_artifact_artifactCrud_get_get, Contract_0.artifactCrud['get'].inputSchema);
    const cmd_artifact_artifactCrud_resolve_resolve = artifact.command('resolve').description(`CRUD resolve for artifact (artifactCrud)`);
    cmd_artifact_artifactCrud_resolve_resolve.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('artifact.resolve', o, Contract_0.artifactCrud['resolve'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_artifact_artifactCrud_resolve_resolve, Contract_0.artifactCrud['resolve'].inputSchema);
    const cmd_artifact_artifactCrud_update_update = artifact.command('update').description(`CRUD update for artifact (artifactCrud)`);
    cmd_artifact_artifactCrud_update_update.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('artifact.update', o, Contract_0.artifactCrud['update'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_artifact_artifactCrud_update_update, Contract_0.artifactCrud['update'].inputSchema);
    const cmd_artifact_artifactCrud_delete_delete = artifact.command('delete').description(`CRUD delete for artifact (artifactCrud)`);
    cmd_artifact_artifactCrud_delete_delete.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('artifact.delete', o, Contract_0.artifactCrud['delete'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_artifact_artifactCrud_delete_delete, Contract_0.artifactCrud['delete'].inputSchema);
    const build = program.command('build').description('build tools');
    const cmd_build_buildCrud_create_create = build.command('create').description(`CRUD create for build (buildCrud)`);
    cmd_build_buildCrud_create_create.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('build.create', o, Contract_0.buildCrud['create'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_build_buildCrud_create_create, Contract_0.buildCrud['create'].inputSchema);
    const cmd_build_buildCrud_find_find = build.command('find').description(`CRUD find for build (buildCrud)`);
    cmd_build_buildCrud_find_find.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('build.find', o, Contract_0.buildCrud['find'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_build_buildCrud_find_find, Contract_0.buildCrud['find'].inputSchema);
    const cmd_build_buildCrud_findOne_find_one = build.command('find_one').description(`CRUD findOne for build (buildCrud)`);
    cmd_build_buildCrud_findOne_find_one.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('build.find_one', o, Contract_0.buildCrud['findOne'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_build_buildCrud_findOne_find_one, Contract_0.buildCrud['findOne'].inputSchema);
    const cmd_build_buildCrud_count_count = build.command('count').description(`CRUD count for build (buildCrud)`);
    cmd_build_buildCrud_count_count.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('build.count', o, Contract_0.buildCrud['count'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_build_buildCrud_count_count, Contract_0.buildCrud['count'].inputSchema);
    const cmd_build_buildCrud_get_get = build.command('get').description(`CRUD get for build (buildCrud)`);
    cmd_build_buildCrud_get_get.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('build.get', o, Contract_0.buildCrud['get'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_build_buildCrud_get_get, Contract_0.buildCrud['get'].inputSchema);
    const cmd_build_buildCrud_resolve_resolve = build.command('resolve').description(`CRUD resolve for build (buildCrud)`);
    cmd_build_buildCrud_resolve_resolve.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('build.resolve', o, Contract_0.buildCrud['resolve'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_build_buildCrud_resolve_resolve, Contract_0.buildCrud['resolve'].inputSchema);
    const cmd_build_buildCrud_update_update = build.command('update').description(`CRUD update for build (buildCrud)`);
    cmd_build_buildCrud_update_update.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('build.update', o, Contract_0.buildCrud['update'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_build_buildCrud_update_update, Contract_0.buildCrud['update'].inputSchema);
    const cmd_build_buildCrud_delete_delete = build.command('delete').description(`CRUD delete for build (buildCrud)`);
    cmd_build_buildCrud_delete_delete.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('build.delete', o, Contract_0.buildCrud['delete'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_build_buildCrud_delete_delete, Contract_0.buildCrud['delete'].inputSchema);
    const catalog = program.command('catalog').description('catalog tools');
    const cmd_catalog_publishContract_publish = catalog.command('publish').description(`Publish one version of a part, creating the part on first publish.`);
    cmd_catalog_publishContract_publish.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('catalog.publish', o, Contract_1.publishContract, cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_catalog_publishContract_publish, Contract_1.publishContract.inputSchema);
    const cmd_catalog_resolveContract_resolve = catalog.command('resolve').description(`Resolve version requirements against published versions.`);
    cmd_catalog_resolveContract_resolve.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('catalog.resolve', o, Contract_1.resolveContract, cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_catalog_resolveContract_resolve, Contract_1.resolveContract.inputSchema);
    const part = program.command('part').description('part tools');
    const cmd_part_partCrud_create_create = part.command('create').description(`CRUD create for part (partCrud)`);
    cmd_part_partCrud_create_create.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('part.create', o, Contract_1.partCrud['create'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_part_partCrud_create_create, Contract_1.partCrud['create'].inputSchema);
    const cmd_part_partCrud_find_find = part.command('find').description(`CRUD find for part (partCrud)`);
    cmd_part_partCrud_find_find.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('part.find', o, Contract_1.partCrud['find'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_part_partCrud_find_find, Contract_1.partCrud['find'].inputSchema);
    const cmd_part_partCrud_findOne_find_one = part.command('find_one').description(`CRUD findOne for part (partCrud)`);
    cmd_part_partCrud_findOne_find_one.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('part.find_one', o, Contract_1.partCrud['findOne'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_part_partCrud_findOne_find_one, Contract_1.partCrud['findOne'].inputSchema);
    const cmd_part_partCrud_count_count = part.command('count').description(`CRUD count for part (partCrud)`);
    cmd_part_partCrud_count_count.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('part.count', o, Contract_1.partCrud['count'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_part_partCrud_count_count, Contract_1.partCrud['count'].inputSchema);
    const cmd_part_partCrud_get_get = part.command('get').description(`CRUD get for part (partCrud)`);
    cmd_part_partCrud_get_get.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('part.get', o, Contract_1.partCrud['get'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_part_partCrud_get_get, Contract_1.partCrud['get'].inputSchema);
    const cmd_part_partCrud_resolve_resolve = part.command('resolve').description(`CRUD resolve for part (partCrud)`);
    cmd_part_partCrud_resolve_resolve.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('part.resolve', o, Contract_1.partCrud['resolve'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_part_partCrud_resolve_resolve, Contract_1.partCrud['resolve'].inputSchema);
    const cmd_part_partCrud_update_update = part.command('update').description(`CRUD update for part (partCrud)`);
    cmd_part_partCrud_update_update.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('part.update', o, Contract_1.partCrud['update'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_part_partCrud_update_update, Contract_1.partCrud['update'].inputSchema);
    const cmd_part_partCrud_delete_delete = part.command('delete').description(`CRUD delete for part (partCrud)`);
    cmd_part_partCrud_delete_delete.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('part.delete', o, Contract_1.partCrud['delete'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_part_partCrud_delete_delete, Contract_1.partCrud['delete'].inputSchema);
    const partVersion = program.command('partVersion').description('partVersion tools');
    const cmd_partVersion_partVersionCrud_create_create = partVersion.command('create').description(`CRUD create for partVersion (partVersionCrud)`);
    cmd_partVersion_partVersionCrud_create_create.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('partVersion.create', o, Contract_1.partVersionCrud['create'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_partVersion_partVersionCrud_create_create, Contract_1.partVersionCrud['create'].inputSchema);
    const cmd_partVersion_partVersionCrud_find_find = partVersion.command('find').description(`CRUD find for partVersion (partVersionCrud)`);
    cmd_partVersion_partVersionCrud_find_find.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('partVersion.find', o, Contract_1.partVersionCrud['find'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_partVersion_partVersionCrud_find_find, Contract_1.partVersionCrud['find'].inputSchema);
    const cmd_partVersion_partVersionCrud_findOne_find_one = partVersion.command('find_one').description(`CRUD findOne for partVersion (partVersionCrud)`);
    cmd_partVersion_partVersionCrud_findOne_find_one.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('partVersion.find_one', o, Contract_1.partVersionCrud['findOne'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_partVersion_partVersionCrud_findOne_find_one, Contract_1.partVersionCrud['findOne'].inputSchema);
    const cmd_partVersion_partVersionCrud_count_count = partVersion.command('count').description(`CRUD count for partVersion (partVersionCrud)`);
    cmd_partVersion_partVersionCrud_count_count.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('partVersion.count', o, Contract_1.partVersionCrud['count'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_partVersion_partVersionCrud_count_count, Contract_1.partVersionCrud['count'].inputSchema);
    const cmd_partVersion_partVersionCrud_get_get = partVersion.command('get').description(`CRUD get for partVersion (partVersionCrud)`);
    cmd_partVersion_partVersionCrud_get_get.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('partVersion.get', o, Contract_1.partVersionCrud['get'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_partVersion_partVersionCrud_get_get, Contract_1.partVersionCrud['get'].inputSchema);
    const cmd_partVersion_partVersionCrud_resolve_resolve = partVersion.command('resolve').description(`CRUD resolve for partVersion (partVersionCrud)`);
    cmd_partVersion_partVersionCrud_resolve_resolve.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('partVersion.resolve', o, Contract_1.partVersionCrud['resolve'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_partVersion_partVersionCrud_resolve_resolve, Contract_1.partVersionCrud['resolve'].inputSchema);
    const cmd_partVersion_partVersionCrud_update_update = partVersion.command('update').description(`CRUD update for partVersion (partVersionCrud)`);
    cmd_partVersion_partVersionCrud_update_update.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('partVersion.update', o, Contract_1.partVersionCrud['update'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_partVersion_partVersionCrud_update_update, Contract_1.partVersionCrud['update'].inputSchema);
    const cmd_partVersion_partVersionCrud_delete_delete = partVersion.command('delete').description(`CRUD delete for partVersion (partVersionCrud)`);
    cmd_partVersion_partVersionCrud_delete_delete.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('partVersion.delete', o, Contract_1.partVersionCrud['delete'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_partVersion_partVersionCrud_delete_delete, Contract_1.partVersionCrud['delete'].inputSchema);
    const cdn = program.command('cdn').description('cdn tools');
    const cmd_cdn_siteComposeContract_site_compose = cdn.command('site_compose').description(`Resolve a site's parts, generate its page, and record what it now serves.`);
    cmd_cdn_siteComposeContract_site_compose.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('cdn.site_compose', o, Contract_2.siteComposeContract, cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_cdn_siteComposeContract_site_compose, Contract_2.siteComposeContract.inputSchema);
    const site = program.command('site').description('site tools');
    const cmd_site_siteCrud_create_create = site.command('create').description(`CRUD create for site (siteCrud)`);
    cmd_site_siteCrud_create_create.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('site.create', o, Contract_2.siteCrud['create'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_site_siteCrud_create_create, Contract_2.siteCrud['create'].inputSchema);
    const cmd_site_siteCrud_find_find = site.command('find').description(`CRUD find for site (siteCrud)`);
    cmd_site_siteCrud_find_find.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('site.find', o, Contract_2.siteCrud['find'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_site_siteCrud_find_find, Contract_2.siteCrud['find'].inputSchema);
    const cmd_site_siteCrud_findOne_find_one = site.command('find_one').description(`CRUD findOne for site (siteCrud)`);
    cmd_site_siteCrud_findOne_find_one.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('site.find_one', o, Contract_2.siteCrud['findOne'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_site_siteCrud_findOne_find_one, Contract_2.siteCrud['findOne'].inputSchema);
    const cmd_site_siteCrud_count_count = site.command('count').description(`CRUD count for site (siteCrud)`);
    cmd_site_siteCrud_count_count.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('site.count', o, Contract_2.siteCrud['count'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_site_siteCrud_count_count, Contract_2.siteCrud['count'].inputSchema);
    const cmd_site_siteCrud_get_get = site.command('get').description(`CRUD get for site (siteCrud)`);
    cmd_site_siteCrud_get_get.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('site.get', o, Contract_2.siteCrud['get'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_site_siteCrud_get_get, Contract_2.siteCrud['get'].inputSchema);
    const cmd_site_siteCrud_resolve_resolve = site.command('resolve').description(`CRUD resolve for site (siteCrud)`);
    cmd_site_siteCrud_resolve_resolve.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('site.resolve', o, Contract_2.siteCrud['resolve'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_site_siteCrud_resolve_resolve, Contract_2.siteCrud['resolve'].inputSchema);
    const cmd_site_siteCrud_update_update = site.command('update').description(`CRUD update for site (siteCrud)`);
    cmd_site_siteCrud_update_update.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('site.update', o, Contract_2.siteCrud['update'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_site_siteCrud_update_update, Contract_2.siteCrud['update'].inputSchema);
    const cmd_site_siteCrud_delete_delete = site.command('delete').description(`CRUD delete for site (siteCrud)`);
    cmd_site_siteCrud_delete_delete.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('site.delete', o, Contract_2.siteCrud['delete'], cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_site_siteCrud_delete_delete, Contract_2.siteCrud['delete'].inputSchema);
    const identity = program.command('identity').description('identity tools');
    const cmd_identity_ticketIssueContract_ticket_issue = identity.command('ticket_issue').description(`Exchange credentials for an opaque ticket.`);
    cmd_identity_ticketIssueContract_ticket_issue.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('identity.ticket_issue', o, Contract_3.ticketIssueContract, cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_identity_ticketIssueContract_ticket_issue, Contract_3.ticketIssueContract.inputSchema);
    const cmd_identity_ticketValidateContract_ticket_validate = identity.command('ticket_validate').description(`Is this ticket valid, and whose is it.`);
    cmd_identity_ticketValidateContract_ticket_validate.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('identity.ticket_validate', o, Contract_3.ticketValidateContract, cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_identity_ticketValidateContract_ticket_validate, Contract_3.ticketValidateContract.inputSchema);
    const cmd_identity_ticketRevokeContract_ticket_revoke = identity.command('ticket_revoke').description(`Revoke one ticket, or every ticket a principal holds.`);
    cmd_identity_ticketRevokeContract_ticket_revoke.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('identity.ticket_revoke', o, Contract_3.ticketRevokeContract, cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_identity_ticketRevokeContract_ticket_revoke, Contract_3.ticketRevokeContract.inputSchema);
    const cmd_identity_revocationsSinceContract_revocations_since = identity.command('revocations_since').description(`Revocations after a given epoch, for an API instance catching up.`);
    cmd_identity_revocationsSinceContract_revocations_since.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('identity.revocations_since', o, Contract_3.revocationsSinceContract, cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_identity_revocationsSinceContract_revocations_since, Contract_3.revocationsSinceContract.inputSchema);
    const cmd_identity_whoamiContract_whoami = identity.command('whoami').description(`Who the caller is, and which organizations they belong to.`);
    cmd_identity_whoamiContract_whoami.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('identity.whoami', o, Contract_3.whoamiContract, cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_identity_whoamiContract_whoami, Contract_3.whoamiContract.inputSchema);
    const cmd_identity_registerContract_register = identity.command('register').description(`Create an account.`);
    cmd_identity_registerContract_register.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('identity.register', o, Contract_3.registerContract, cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_identity_registerContract_register, Contract_3.registerContract.inputSchema);
    const cmd_identity_permitsContract_permits = identity.command('permits').description(`Whether a caller holding these roles may call a contract.`);
    cmd_identity_permitsContract_permits.action(async (o: Record<string, unknown>, cmd: Command) => {
        try {
            await executeCommand('identity.permits', o, Contract_3.permitsContract, cmd.optsWithGlobals());
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(C.red + 'Error:' + C.reset, message);
        }
    });
    ZodToCliMapper.applyOptions(cmd_identity_permitsContract_permits, Contract_3.permitsContract.inputSchema);
}
