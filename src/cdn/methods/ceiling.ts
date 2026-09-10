/**
 * **What a seed is allowed to grant, and to whom.**
 *
 * F30 stage 2. Seeding a site installs the roles an application declares, as **grants** — rows a
 * caller's role carries, which `permits` then answers with. That is what makes a tenant's own
 * application usable by its own members (F27) without a per-contract flag typed by hand.
 *
 * A grant is data, and data is editable by whoever can write it, so the interesting question is not
 * *how* to install one but **what a seed may never install**. Two rules, and the second is the one
 * that stops this being an escalation:
 *
 * 1. **Only what the site actually serves.** A grant for a contract the host does not expose is a
 *    row that can never be used and, worse, one that becomes live the day somebody adds the contract
 *    for an unrelated reason. The exposed set is already computed — `grantsFor(release.requires)` —
 *    so this costs nothing and is exact.
 *
 * 2. **Never a domain this repository defines.** `release.requires` is derived from what the
 *    composed parts declare they call, and **a part declares its own requirements**. So a part that
 *    named `cdn.deploy` in its `mesh` block would have it exposed on that site, and a seed that
 *    granted the site's whole exposed set would hand `cdn.deploy` to a tenant role. The platform's
 *    own contracts are not a tenant's to be granted by composing a manifest that asks for them.
 *
 * F27's note already reached rule 2 from the other direction — *"`gateFor`'s default must stay
 * `operator` for this repository's own domains"* — and this is the same sentence said about grants
 * rather than about gates.
 *
 * **What this deliberately does not do** is make roles per-organization. A role key is globally
 * unique, so `owner` is one row and a grant on it is a grant for every organization's owner. That is
 * bounded twice over — a contract is only reachable on a host whose site exposes it, and a
 * `scopedBy` collection confines every row to the caller's own organization — and rule 2 is what
 * keeps it from being bounded only by those. Whether role *definitions* should be per-organization
 * is a real question and is recorded on F30 rather than decided here.
 */

/**
 * The domains this repository defines.
 *
 * Written out rather than derived at run time, because the check has to work in `site.seed` where
 * there is no registry to ask, and a list that is wrong in the *safe* direction — naming a domain
 * that does not exist — costs nothing. Wrong in the other direction is an escalation, so
 * `test/cdn/ceiling.test.ts` scans `src/**\/contracts/*.ts` for every `domain:` and every
 * `defineCrud(` and **fails naming any domain missing from this list.** A new platform domain
 * therefore cannot be added without this being updated.
 */
export const PLATFORM_DOMAINS: ReadonlySet<string> = new Set([
    'api', 'apiToken', 'approval', 'artifact', 'build', 'builder', 'catalog', 'cdn', 'edge',
    'grant', 'group', 'identity', 'membership', 'node', 'organization', 'part', 'partVersion',
    'release', 'role', 'site', 'telem', 'ticket', 'user',
]);

/** The domain half of a contract key. `card.update` is `card`; a key with no dot is its own domain. */
export function domainOf(key: string): string {
    const dot = key.indexOf('.');
    return dot === -1 ? key : key.slice(0, dot);
}

/**
 * The contracts a seed may grant on this site: what it exposes, minus the platform's own.
 *
 * Takes the exposed keys rather than a release, because the caller has already computed them and
 * recomputing would be a second answer to *what does this site serve* — which is the shape of
 * defect this repository keeps finding.
 */
export function ceilingFor(exposed: readonly string[]): readonly string[] {
    return [...new Set(exposed)]
        .filter((key) => !PLATFORM_DOMAINS.has(domainOf(key)))
        .sort();
}

/**
 * The grants to install for one site, by role.
 *
 * `owner` gets the whole ceiling: they own the organization the application belongs to, and a
 * hosted application whose owner cannot use it is F27. Every other role gets **what it declared,
 * intersected with the ceiling** — a role map travels with the parts (`release.agentRoles`), and a
 * part naming a contract its site does not serve gets nothing rather than a grant that waits.
 *
 * Returns the pairs rather than writing them, so the rule is testable without a store.
 */
export function grantsToInstall(
    exposed: readonly string[],
    declaredRoles: Readonly<Record<string, readonly string[]>>,
): readonly { readonly roleKey: string; readonly contract: string }[] {
    const ceiling = ceilingFor(exposed);
    const allowed = new Set(ceiling);

    const out: { roleKey: string; contract: string }[] = [];
    for (const contract of ceiling) out.push({ roleKey: 'owner', contract });

    for (const roleKey of Object.keys(declaredRoles).sort()) {
        // `owner` is this platform's word for whoever owns the organization. A part redefining it
        // would be widening or narrowing a role the platform assigns, which is not a part's to do.
        if (roleKey === 'owner') continue;
        for (const contract of [...(declaredRoles[roleKey] ?? [])].sort()) {
            if (allowed.has(contract)) out.push({ roleKey, contract });
        }
    }

    return out;
}
