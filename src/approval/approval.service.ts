/**
 * The `approval` ServiceModule.
 *
 * A call an agent asked to make, parked until a person decides — `spec/mcp.md` §7.
 *
 * **Here rather than in an application.** flowboard's `gate` record is this idea already
 * (`{ cardId, kind, status, approvedBy, approvedAt, rejectionReason }`) built for one app and one
 * pair of decisions. Every application with an agent surface needs the same thing, so it is platform
 * machinery; flowboard's gates become a specialisation of this rather than the original of it.
 *
 * **And here rather than in mesh.** `mesh/docs/STABILITY.md`: the framework is frozen, and the test
 * to apply is *could this be built in mesh-serve instead*. It can, as a `ServiceModule` subclass —
 * which is what `ApiService` and `McpService` already are.
 */

import { ServiceModule } from '@flybyme/mesh';

import {
    approvalCheckContract,
    approvalCrud,
    approvalDecideContract,
    approvalRequestContract,
} from './contracts/approval.contract.js';
import { approval_request } from './tools/request.js';
import { approval_check } from './tools/check.js';
import { approval_decide } from './tools/decide.js';

export class ApprovalService extends ServiceModule {
    public readonly domain = 'approval';

    constructor() {
        super();

        this.mountCrud(approvalCrud);

        this.mountTool(approvalRequestContract, approval_request);
        this.mountTool(approvalCheckContract, approval_check);
        this.mountTool(approvalDecideContract, approval_decide);
    }
}

export default ApprovalService;
