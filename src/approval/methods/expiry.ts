/**
 * Has this waited too long?
 *
 * A pure function, separate from anything that reads a clock or a collection, because it is the one
 * rule that decides whether an agent is still waiting or has been let go — and a rule like that
 * should be testable without a database.
 *
 * **Expiry is computed on read, not swept.** A background sweeper is a second thing that can be not
 * running, and an approval that is expired-in-fact but pending-in-the-record is exactly the state
 * that leaves an agent polling forever. Reading decides; a sweeper, if one is ever added, only
 * tidies.
 */

import type { ApprovalStatus } from '../schema/approval.js';

export interface Expirable {
    readonly status: ApprovalStatus;
    readonly expiresAt: Date | string;
}

export function effectiveStatus(row: Expirable, now: Date = new Date()): ApprovalStatus {
    if (row.status !== 'pending') return row.status;
    const expires = row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt);
    return expires.getTime() <= now.getTime() ? 'expired' : 'pending';
}

/**
 * The sentence an agent reads when it has run out of time.
 *
 * Written for a model rather than a log: it says what happened, that retrying this id will not help,
 * and what would. A message that only says "expired" gets polled again.
 */
export const EXPIRED_REASON =
    'Nobody decided this before it expired. The call was not made. '
    + 'Checking this id again will not change that — ask again if it still needs doing.';
