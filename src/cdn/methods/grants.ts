import { PLATFORM_DOMAINS, domainOf } from './ceiling.js';

/**
 * **What a site grants, derived from what its release actually calls.**
 *
 * Moved here from `bring-up.ts` unchanged. It lived beside the CLI that seeded a cluster, which was
 * fine while the CLI was the only thing that could seed one — and `site.seed` is now a contract, so
 * a browser can too. Two implementations of *what gate does this contract go behind* would drift the
 * first time somebody added a domain, and the drift would be a site that grants a write at `user`.
 *
 * `bring-up.ts` still imports both. Nothing about the rules changed in the move.
 */


/**
 * What gate a contract goes behind, when nobody has said otherwise.
 *
 * **A part must never choose its own gate**, so this is the site owner's policy written once rather
 * than typed out per contract. The shape of it is the interesting part:
 *
 * - `public` — the two calls a signed-out browser must make. Not *harmless*, not *read-only*:
 *   **required in order to sign in at all**, which is the only thing that earns `public`.
 * - `user` — reading.
 * - `operator` — everything that changes what runs on a hostname: composing, deploying, releasing,
 *   assigning a node its services.
 *
 * The default is `operator`, deliberately. A contract this table has not been taught about is one
 * nobody has classified, and the safe answer to *I do not know what this does* is the strictest
 * gate — a too-strict gate is a 403 somebody reports, a too-loose one is not noticed.
 */
export function gateFor(key: string): 'public' | 'user' | 'admin' | 'operator' {
    const PUBLIC = new Set([
        'identity.register',
        'identity.ticket_issue',
        /**
         * **Public because the failures worth recording happen before anyone signs in.**
         *
         * A page that cannot boot, a part that throws on mount, a call refused for want of a
         * session — every one of those happens to an anonymous browser, and gating telemetry at
         * `user` would collect nothing from precisely the sessions somebody needs to see.
         *
         * `public` is not free here and the server is what makes it affordable: `telem.ingest`
         * bounds a batch at 100 events, rate-limits per session and per host, and stores keys and
         * outcomes rather than inputs. The gate is open; the door is narrow.
         */
        'telem.ingest',
    ]);
    if (PUBLIC.has(key)) return 'public';

    const USER = new Set([
        'identity.whoami', 'identity.sign_out', 'identity.ticket_revoke',
        /**
         * **A person may change their own password, and on every site this was `operator`.**
         *
         * It is a write, it matches none of the read patterns, so it fell to the default — and the
         * default is the right instinct applied to the wrong contract. `set_password` takes no
         * subject id, deliberately: *"the caller **is** the subject"*, which the contract states in
         * the comment directly above its own visibility. There is no version of this an operator
         * needs to do on somebody else's behalf, and no version a signed-in person should be
         * refused.
         *
         * Found on the live two-tenant cluster: flowboard's own owner, signed in to their own site,
         * got 403 on their own password. Roadmap F28.
         */
        'identity.set_password',
        'catalog.resolve', 'builder.get_artifact', 'builder.artifact_blob',
    ]);
    if (USER.has(key)) return 'user';

    /**
     * **The fleet answers operators, including its reads.**
     *
     * `node.status` was in the `user` set above and that was wrong in the way that is hardest to
     * see: the site let the request through the gate, and then `requireOperator` inside the handler
     * refused it — a 403 on a call the site had promised a signed-in user could make. The gate and
     * the contract disagreed, and the gate is the half a person configures.
     *
     * A gate can be stricter than a handler safely; the reverse is a promise the platform will not
     * keep. So everything the fleet owns matches what its handlers actually demand — what machines
     * exist and what each is running is operator business either way.
     */
    if (/^(node|group)\./.test(key)) return 'operator';

    /**
     * Generated reads.
     *
     * Safe **only where the collection declares `scopedBy`**, which narrows a find to the caller's
     * organization so it cannot be widened into somebody else's data. That is true of `site` and is
     * *not* true of `release`, whose own comment claims otherwise — roadmap D7. This line is
     * therefore slightly ahead of the platform, and the note is here so it is not mistaken for a
     * guarantee: fixing D7 is what makes it one.
     */
    if (/\.(find|find_one|get|count)$/.test(key)) return 'user';

    return 'operator';
}

/**
 * One entry in a site's grant list: a coarse level, or a named permission the site's hook evaluates.
 *
 * Both shapes were always representable — `site.mesh[].contracts` carries `auth` *or* `permission`,
 * and `gateOf` refuses an entry declaring both. Until F30 stage 3 this function only ever produced
 * the first, which is why the second had no callers to find out it was never evaluated.
 */
export type GrantEntry =
    | { readonly key: string; readonly auth: 'public' | 'user' | 'admin' | 'operator' }
    | { readonly key: string; readonly permission: string };

/**
 * The site's grants, derived from what the deployed release actually calls.
 *
 * **Not a hand-written list**, which matters more than it looks. `cdn.deploy` refuses a release
 * calling a contract the site does not expose — correctly, since the alternative is a 404 at run
 * time found by whoever opens the page — so a maintained-by-hand list goes stale exactly when a new
 * part is added, which is the moment somebody is least able to guess why the deploy was refused.
 *
 * Three are added whether or not a part declares them. `identity.register` and
 * `identity.ticket_issue`, because a page nobody can sign in to cannot use anything else it was
 * granted — and `telem.ingest`, for a reason that is nearly the same and easy to miss.
 *
 * **A grant derived from `release.requires` can never bootstrap telemetry.** The parts worth
 * hearing from are the ones failing to mount, and a part that fails to mount does not get to
 * declare anything. Worse, the useful failures are on *first* deploy, before any part has declared
 * a dependency on it. So it is granted up front, exactly like signing in: a capability the page
 * needs in order for the rest of the page to be diagnosable at all.
 */
/**
 * **Granted to every site whether or not a part declares them — and therefore exempt from the
 * release filter, which is the half that was missing.**
 *
 * `api.service.ts` narrows a site's granted contracts by the deployed release's `requires`, so a
 * site exposes what it serves. Correct, and it deleted **exactly these three**, because a contract
 * nobody declares is a contract not in `requires`. The one mechanism that says *grant this anyway*
 * and the one that says *only what is declared* met, and the second won silently.
 *
 * Measured on a live cluster before the fix: a seeded site served `identity.ticket_issue` — only
 * because the console's own manifest happens to name it — and served neither `identity.register` nor
 * `telem.ingest`. So the platform had **no exposed way to create an account**, anywhere, and the
 * reasons each is here were each defeated in their own terms:
 *
 * - **`identity.register` and `identity.ticket_issue`**, because *a page nobody can sign in to
 *   cannot use anything else it was granted.* A site that granted sign-in only when an app
 *   remembered to ask is a site where forgetting locks everyone out.
 * - **`telem.ingest`**, and this is the one that bites hardest. *The parts worth hearing from are
 *   the ones failing to mount, and a part that fails to mount does not get to declare anything* —
 *   so requiring it to be declared means the failures it exists to report are exactly the failures
 *   it cannot report. First deploy, nothing declared, nothing heard.
 *
 * Exported so the descriptor can skip the filter for these, rather than repeating the list. A second
 * copy of a security-relevant set is how the two drift.
 */
export const ALWAYS_GRANTED: readonly string[] = [
    'identity.register',
    'identity.ticket_issue',
    'telem.ingest',
];

export function grantsFor(
    requires: readonly string[],
    /**
     * The release's agent role map, if it composed one.
     *
     * Read here because **a gate the role holder cannot pass makes the role map decorative.**
     * `gateFor` ends in `return 'operator'`, which is the right default for a guess — a gate
     * stricter than the handler is safe and the reverse is a promise the platform will not keep. But
     * an agent role is by definition held by somebody who is *not* an operator, so every write named
     * in a role was granted at a gate its own callers could never reach. Found the first time a real
     * worker token asked: it was offered nothing but its approval poll.
     *
     * So a contract a role names is gated at `user`, never looser than `gateFor` would have it. The
     * two halves then say different things and both are needed: the site says *a signed-in caller
     * may reach this*, and the role map says *and only these roles see it over MCP*. A contract no
     * role names — `worktree.dispatch`, `worktree.merge` — keeps the operator gate, which is how a
     * gate stays a person's decision.
     */
    agentRoles?: Readonly<Record<string, readonly string[]>>,
): {
    contracts: GrantEntry[];
    events: { key: string; auth: 'public' | 'user' | 'admin' | 'operator' }[];
} {
    const keys = new Set([...requires, ...ALWAYS_GRANTED]);

    const named = new Set(Object.values(agentRoles ?? {}).flat());
    const contracts: GrantEntry[] = [...keys].sort().map((key) => {
        const gate = gateFor(key);

        /**
         * **A contract in a domain this repository does not define is answered by a grant.**
         *
         * `gateFor` decides a gate from the key and nothing else, so it can only recognise names
         * defined *here* — a hosted application's contracts match none of its rules, by
         * construction. `public` is the one exception and stays one: the calls a signed-out browser
         * must make in order to sign in at all cannot be behind a grant, because holding a grant
         * requires a session.
         */
        if (gate !== 'public' && !PLATFORM_DOMAINS.has(domainOf(key))) {
            return { key, permission: key };
        }

        // Never loosen below what `gateFor` decided: `public` stays public, and `user` is already
        // what this would set. Only an `operator`/`admin` guess on a role-named contract moves.
        //
        // Reached now only for **this repository's own** domains — a foreign contract was answered
        // above, and a grant is a better answer than this lowering for the same reason: it says who,
        // where the lowering only says *somebody signed in*.
        if (named.has(key) && (gate === 'operator' || gate === 'admin')) {
            return { key, auth: 'user' as const };
        }

        /**
         * **F30 stage 3, and why this is not a loosening.**
         *
         * `gateFor` ends in `return 'operator'` because a key it has not been taught about is one
         * nobody has classified, and the strict answer is the safe one for a *guess*. Right for this
         * repository's own domains; wrong applied to a hosted application's, where it lands on every
         * contract — all of them, since the table only knows names defined here.
         *
         * There is nothing to guess, because **the permission name and the contract key are the same
         * string**, and `permits` denies by default: a contract nobody granted is refused exactly as
         * the old default refused it. What changes is *who* can be granted it.
         *
         * Measured on flowboard before the writes moved: the account that **owns Flowboard Inc** could
         * create a card and could not move it, because `card.create` is named by an agent role map and
         * `card.update` is not. Whether a person could move a card depended on whether an unrelated
         * *agent* part had been composed.
         *
         * The reads moved for the reason `gateFor`'s read line states about itself — *"safe **only**
         * where the collection declares `scopedBy` … this line is therefore slightly ahead of the
         * platform"*. It answered `user` to any signed-in caller and leaned entirely on the collection
         * to confine the rows: one mechanism doing the work of two, on a line that says so. A
         * permission does not replace `scopedBy`; it stops being the only thing between a signed-in
         * stranger and a tenant's board.
         */
        return { key, auth: gate };
    });

    /**
     * Every exposed collection streams its own CRUD events, at the gate its `find` has.
     *
     * This is what makes a list in the console *live* rather than a snapshot with a refresh button
     * beside it: mesh-web subscribes to `${name}.created|updated|deleted` for a collection the
     * generated client declares, and the client declares only what the site exposes. The gate has
     * to match the collection's own — looser would push rows to somebody who may not read them.
     */
    const domains = [...new Set(
        contracts
            .filter((entry) => entry.key.endsWith('.find'))
            .map((entry) => entry.key.slice(0, entry.key.indexOf('.'))),
    )].sort();

    const events = domains.flatMap((domain) => ['created', 'updated', 'deleted'].map((verb) => ({
        key: `${domain}.${verb}`,
        auth: gateFor(`${domain}.find`),
    })));

    return { contracts, events };
}
