/**
 * The `builder` ServiceModule.
 *
 * Two collections and two tools, and the split between them is the rule this repository follows
 * everywhere: **CRUD is generated in full and used idiomatically; anything with a side effect or an
 * invariant is an explicit tool that does the work and then writes through the normal CRUD path.**
 *
 * So an artifact record is CRUD, because reading one is a read. Producing one is not — it fetches a
 * commit, runs a bundler and stores bytes — so `build_start` exists, and `artifact.create` is called
 * by nothing but that tool.
 *
 * Nothing is hooked. A generated handler that quietly bundled something would be a dependency
 * nothing declared and no scheduler could see.
 */

import { ServiceModule, type IServiceBroker } from '@flybyme/mesh';

import { gridfsBlobStore, type BlobStore } from './blobs.js';
import {
    artifactBlobContract, artifactCrud, buildCrud, buildStartContract, getArtifactContract,
} from './contracts/artifact.contract.js';
import { DEFAULT_MAX_BYTES } from './methods/bundle.js';
import { gitFetcher, type Fetcher } from './methods/source.js';
import { builder_artifact_blob } from './tools/artifact_blob.js';
import { builder_build_start } from './tools/build_start.js';
import { builder_get_artifact } from './tools/get_artifact.js';

export interface BuilderServiceOptions {
    /**
     * How a source reference becomes a workspace.
     *
     * Overridable so the *rule* can be tested without a network: a fetcher receives a reference and
     * a destination it did not choose, which is what stops a source ever being "wherever it already
     * is".
     */
    readonly fetcher?: Fetcher;
    /** Where bytes go. Defaults to GridFS on the framework's database, resolved at start. */
    readonly blobs?: BlobStore;
    readonly maxBytes?: number;
    /**
     * The origin content is downloaded from — what `artifact_blob` puts in front of a digest.
     *
     * A deployment decision, not a builder one: it is wherever these bytes are reachable from, which
     * behind a proxy is not the address of any node. Absent means relative, which is only correct
     * when the caller is on the same origin.
     */
    readonly blobOrigin?: string;
}

export class BuilderService extends ServiceModule {
    public readonly domain = 'builder';

    public fetch: Fetcher;
    public maxBytes: number;

    /**
     * Assigned in `onStart` from the broker's `database` provider unless one was supplied.
     *
     * Not in the constructor, because the database is not connected when a module is constructed —
     * and a store built against a disconnected database would fail on the first build rather than at
     * boot, which is the wrong end of the day to find out.
     */
    public blobs!: BlobStore;

    constructor(private readonly options: BuilderServiceOptions = {}) {
        super();

        this.fetch = options.fetcher ?? gitFetcher;
        this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

        this.mountCrud(artifactCrud);
        this.mountCrud(buildCrud);

        this.mountTool(buildStartContract, builder_build_start);
        this.mountTool(getArtifactContract, builder_get_artifact);
        this.mountTool(artifactBlobContract, builder_artifact_blob);
    }

    /**
     * Where a digest is downloaded from.
     *
     * The digest is the whole path, so the URL is immutable and cacheable forever — and two callers
     * asking about the same content are handed the same address, which is what lets anything in
     * front of it cache once for everybody.
     */
    public blobUrl(digest: string): string {
        const slug = digest.slice(digest.indexOf(':') + 1);
        return `${this.options.blobOrigin ?? ''}/blobs/${slug}`;
    }

    async onStart(broker: IServiceBroker): Promise<void> {
        this.blobs = this.options.blobs
            ?? gridfsBlobStore(broker.getProvider('database'));
    }
}

export default BuilderService;
