import { ServiceModule } from '@flybyme/mesh';
import {
    nodeCrud,
    nodeHelloContract,
    nodeAssignContract,
    nodeStatusContract,
} from './contracts/node.contract.js';
import {
    node_hello,
    node_assign,
    node_status,
} from './methods/node.js';

export class FleetService extends ServiceModule {
    public readonly domain = 'node';

    constructor() {
        super();

        this.mountCrud(nodeCrud);
        this.mountTool(nodeHelloContract, node_hello);
        this.mountTool(nodeAssignContract, node_assign);
        this.mountTool(nodeStatusContract, node_status);
    }
}

export default FleetService;
