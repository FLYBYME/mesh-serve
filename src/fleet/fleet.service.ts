import { ServiceModule } from '@flybyme/mesh';
import {
    groupCrud,
    nodeCrud,
    nodeHelloContract,
    nodeAssignContract,
    nodeReconcileContract,
    nodeStatusContract,
} from './contracts/node.contract.js';
import {
    node_hello,
    node_assign,
    node_reconcile,
    node_status,
} from './methods/node.js';

/**
 * The fleet: which machines exist, and what each should be running.
 *
 * It stores **desired** state and nothing else. Observed state — is this node connected, what is it
 * actually running — is read live from the Registry and the Supervisor at the moment it is asked
 * for. `cdn/schema/edge.ts` gives the reason and it holds here: a second heartbeat beside the
 * Registry produces two sources of truth that disagree exactly when it matters.
 *
 * `group` is mounted here rather than in its own service because a group is meaningless without the
 * nodes that reference it — the two collections are one concept stored in two tables, and splitting
 * them across services would put a boundary through the middle of `reconcile`.
 */
export class FleetService extends ServiceModule {
    public readonly domain = 'node';

    constructor() {
        super();

        this.mountCrud(nodeCrud);
        this.mountCrud(groupCrud);
        this.mountTool(nodeHelloContract, node_hello);
        this.mountTool(nodeAssignContract, node_assign);
        this.mountTool(nodeReconcileContract, node_reconcile);
        this.mountTool(nodeStatusContract, node_status);
    }
}

export default FleetService;
