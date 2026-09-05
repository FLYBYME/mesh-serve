/**
 * The `catalog` ServiceModule.
 *
 * What *may* run. The cdn holds what *does*. Every version a site names resolves through here, so
 * this is the collection that makes a range mean anything.
 *
 * Two collections, two tools, nothing hooked.
 */

import { ServiceModule } from '@flybyme/mesh';

import {
    partCrud, partVersionCrud, publishContract, resolveContract,
} from './contracts/part.contract.js';
import { catalog_publish } from './tools/publish.js';
import { catalog_resolve } from './tools/resolve.js';

export class CatalogService extends ServiceModule {
    public readonly domain = 'catalog';

    constructor() {
        super();

        this.mountCrud(partCrud);
        this.mountCrud(partVersionCrud);

        // No `.bind(this)`: `ServiceModule.execute` invokes a handler with `handler.call(this, …)`.
        this.mountTool(publishContract, catalog_publish);
        this.mountTool(resolveContract, catalog_resolve);
    }
}

export default CatalogService;
