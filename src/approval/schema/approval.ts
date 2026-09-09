/**
 * An approval: a call an agent asked to make, parked until a person decides.
 *
 * `spec/mcp.md` §7. The surface already knew which calls need a person — `destructive` is that flag,
 * and it is why an agent is refused one today. What it had no answer for was *and then what*: the
 * refusal says "a person holding a session may call it", which is true and is a dead end. This
 * record is the answer. The call does not fail; it waits.
 *
 * ## Why the input is frozen here
 *
 * Approving `card.create` in the abstract approves nothing — the thing being approved is *this
 * create, with these fields*. So the input is copied onto the record at request time and the call is
 * replayed from the record when it is approved, rather than the agent re-calling. An agent that
 * re-called could send different input than the one a person read.
 *
 * **The cost is that this record holds whatever the agent was about to write**, readable by every
 * approver in the role, for as long as it is kept. That is a real disclosure surface and it is
 * called out in the spec rather than discovered later: `expiresAt` bounds it, and retention beyond
 * that wants deciding before the first sensitive payload rather than after.
 *
 * ## Why the approver is a role and is frozen too
 *
 * A **role**, never an account, so ten operators need no enumeration and one operator leaving does
 * not orphan a pending request. Resolved when the request is made and written down, because *who
 * could approve this* must not change while it is pending — an approval that silently retargets is
 * one nobody is accountable for.
 */

import { z } from '@flybyme/mesh';

export const ApprovalStatusEnum = z.enum(['pending', 'approved', 'rejected', 'expired']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusEnum>;

/**
 * Who asked.
 *
 * `agent` is the API token's name when the caller arrived on one. It is the whole point of the
 * record: an approval that reads *"tim asked"* when tim's agent asked is an audit trail that is a
 * lie, and a person approving needs to know which program is on the other end.
 *
 * Optional because [D9](../../spec/roadmap.md) is not built — today every caller arrives on a
 * person's ticket, so `agent` is absent and the record says so honestly rather than inventing a name.
 */
export const RequesterSchema = z.object({
    userId: z.string().min(1),
    agent: z.string().optional(),
    roles: z.array(z.string()).default([]),
});

export const ApprovalSchema = z.object({
    /**
     * The organization this belongs to. **Present and `scopedBy` below, deliberately.**
     *
     * An unscoped collection is global (`normalizeUniqueKeys`: *"On an unscoped collection: all keys
     * are global"*), which for this collection would mean every approver on the platform reading
     * every pending call's frozen input. That is the exact shape of the `release.find` disclosure in
     * roadmap D8.
     */
    tenantId: z.string().min(1),

    /** `domain.action` — the call that was asked for. */
    call: z.string().min(1),

    /** The site the request arrived at, so an approver can tell two boards apart. */
    host: z.string().default(''),

    /** The frozen input. Replayed on approval; never re-read from the agent. */
    input: z.record(z.string(), z.unknown()).default({}),

    requestedBy: RequesterSchema,
    requestedAt: z.coerce.date(),

    /**
     * `role:<name>` or `user:<id>`. A role in every case the surface raises today.
     *
     * A string rather than a union because the site's `authorize` hook names it, and the set of
     * things a site can mean by "who approves this" is the site's business — the same reason the
     * gate takes a permission string rather than an enum.
     */
    approver: z.string().min(1),

    status: ApprovalStatusEnum.default('pending'),

    /** Bounds the window and the disclosure. A request nobody answers must not wait forever. */
    expiresAt: z.coerce.date(),

    decidedBy: z.string().optional(),
    decidedAt: z.coerce.date().optional(),
    /** Why it was refused. Shown to the agent, so it is worth writing for one. */
    reason: z.string().optional(),

    /**
     * What the replayed call returned, once approved.
     *
     * Held so `approval.check` can hand the agent its result on the next poll. The agent never
     * re-calls, so this is the only place that result exists.
     */
    result: z.unknown().optional(),
    /** Set when the replay itself failed. An approved call that then threw is not an approval failure. */
    error: z.string().optional(),
});

export type Approval = z.infer<typeof ApprovalSchema>;

/** How long a request waits before it expires. A person may be asleep; a week is not an answer. */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** `role:operator` unless a site says otherwise. The narrowest thing that is always true. */
export const DEFAULT_APPROVER = 'role:operator';

/**
 * Does this caller hold what the record names?
 *
 * `role:x` is satisfied by holding `x`; `user:id` by being that user. Kept as a function next to the
 * field it reads so the two cannot drift, and pure so it is testable without a broker.
 */
export function satisfiesApprover(
    approver: string,
    caller: { readonly userId: string; readonly roles: readonly string[] },
): boolean {
    if (approver.startsWith('role:')) return caller.roles.includes(approver.slice('role:'.length));
    if (approver.startsWith('user:')) return caller.userId === approver.slice('user:'.length);
    return false;
}
