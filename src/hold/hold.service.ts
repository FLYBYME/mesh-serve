import { ServiceModule } from '@flybyme/mesh';

import { holdCrud, holdDecideContract } from './contracts/hold.contract.js';
import { decide } from './tools/decide.js';

export class HoldService extends ServiceModule {
    public readonly domain = 'serve.hold';

    constructor() {
        super();

        this.mountCrud(holdCrud);
        this.mountTool(holdDecideContract, decide);
    }
}
