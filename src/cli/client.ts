import { fetchDescriptor, type ExposureDescriptor } from './describe.js';
import { executeCall, type ExecuteResult } from './execute.js';
import type { DescribedCall } from './describe.js';
import type { Session } from './session.js';

/**
 * The one thing that actually talks to a running ApiService, over plain REST -- everything else in
 * this CLI (meta commands, the dynamic command tree) goes through this rather than importing fetch
 * mechanics directly. Exists as one seam so an SSE subscription (`/events`, once the api server has
 * one) has somewhere to live later without reshaping every caller again.
 */
export interface Client {
    describe(apiHost: string): Promise<ExposureDescriptor>;
    call(session: Session, call: DescribedCall, args: Record<string, unknown>): Promise<ExecuteResult>;
}

export const restClient: Client = {
    describe: fetchDescriptor,
    call: executeCall,
};
