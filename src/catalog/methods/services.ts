/**
 * Which `kind: 'service'` parts *this node* currently has loaded, in memory only -- deliberately
 * not persisted. A database flag survives the crash that made it stale; asking this node directly
 * (routed via `ctx.call`'s `nodeID` option, resolved against the mesh's own node registry) never
 * can, since a node that's gone is simply absent from the registry rather than lying about itself.
 */

export interface RunningService {
    /** The primary domain the load registered under. */
    readonly domain: string;
    /** The module this was loaded from, so stopping it can evict that module too. */
    readonly modulePath?: string;
    /** The serve.artifact actually loaded -- absent only for core parts, which are not built artifacts. */
    readonly artifactId?: string;
    /** The organization its serve.part row belongs to: stopping it is scoped by it. */
    readonly tenantId?: string;
}

const running = new Map<string, RunningService>();

/**
 * Keyed by node as well as part.
 *
 * "This node" is one process in production, so a bare partId key was right in practice and wrong
 * in principle -- and the principle bites the moment a single process hosts two brokers, which is
 * exactly what a two-node test is. Without the nodeID, the second node is told a part is already
 * running because the *first* node loaded it.
 */
function key(nodeID: string, partId: string): string {
    return `${nodeID}\u0000${partId}`;
}

export function markServiceRunning(nodeID: string, partId: string, domain: string, modulePath?: string, artifactId?: string, tenantId?: string): void {
    running.set(key(nodeID, partId), {
        domain,
        ...(modulePath !== undefined ? { modulePath } : {}),
        ...(artifactId !== undefined ? { artifactId } : {}),
        ...(tenantId !== undefined ? { tenantId } : {}),
    });
}

/** A catalog part loaded on this node, as a fault names it. */
export interface RunningPart extends RunningService {
    readonly partId: string;
    readonly modulePath: string;
}

/**
 * The catalog part this stack runs through, nearest the throw first: the first frame inside a
 * loaded part's own folder (`<artifacts>/<hash>/`) names it. Undefined when no frame does -- the
 * error is mesh-serve's own, or a library's called from nothing a part owns. Core parts are not
 * catalog parts (no serve.part row to stop) and are never named.
 */
export function partInStack(nodeID: string, stack: string): RunningPart | undefined {
    const parts = catalogPartsOn(nodeID);

    for (const line of stack.split('\n')) {
        const found = parts.find((p) => line.includes(folderOf(p.modulePath)));
        if (found !== undefined) return found;
    }

    return undefined;
}

/**
 * The catalog part whose load owns `owner` (the broker's owner in effect: `part:<module>@<node>`,
 * loadModule.ts), when the stack names none -- an error raised by Node alone (node:net's
 * EADDRINUSE, 11-05) out of work a part's contract started. Core parts are never named.
 */
export function partOfOwner(nodeID: string, owner: string | undefined): RunningPart | undefined {
    if (owner === undefined) return undefined;

    return catalogPartsOn(nodeID).find((p) => ownerOf(nodeID, p.modulePath) === owner);
}

/** Who a load's registrations belong to: one owner per module and node (broker.withOwner). */
export function ownerOf(nodeID: string, absolutePath: string): string {
    return `part:${absolutePath}@${nodeID}`;
}

/** Every catalog part loaded on this node, with the module it came from. */
function catalogPartsOn(nodeID: string): RunningPart[] {
    const prefix = `${nodeID}\u0000`;
    const parts: RunningPart[] = [];
    for (const [entryKey, service] of running) {
        if (!entryKey.startsWith(prefix) || service.modulePath === undefined) continue;
        const partId = entryKey.slice(prefix.length);
        if (partId.startsWith('core:')) continue;
        parts.push({ ...service, partId, modulePath: service.modulePath });
    }

    return parts;
}

/** The folder a part's module sits in, with its trailing separator: `/a/b/` never matches `/a/bc/`. */
function folderOf(modulePath: string): string {
    const cut = modulePath.lastIndexOf('/');
    return cut < 0 ? modulePath : modulePath.slice(0, cut + 1);
}

export function getRunningService(nodeID: string, partId: string): RunningService | undefined {
    return running.get(key(nodeID, partId));
}

export function clearServiceRunning(nodeID: string, partId: string): void {
    running.delete(key(nodeID, partId));
}

/**
 * Starts in progress. A start is only marked running once it has loaded -- tens of seconds for a
 * large part -- and before that a reconcile pass that saw it "not running" would start it again,
 * loading a second copy into the same process.
 */
const starting = new Set<string>();

/** Claims the start of `partId` on this node; false when one is already under way. */
export function claimStart(nodeID: string, partId: string): boolean {
    const k = key(nodeID, partId);
    if (starting.has(k)) return false;
    starting.add(k);
    return true;
}

export function releaseStart(nodeID: string, partId: string): void {
    starting.delete(key(nodeID, partId));
}

/**
 * Everything one node is running, for `serve.part.runningHere`.
 *
 * Core parts are excluded: they are keyed `core:<name>` and are not `serve.part` rows, so they
 * have no desired state for the supervisor to compare against. Only catalog-managed services are
 * its business.
 */
export function listServicesRunning(nodeID: string): { partId: string; domain: string; artifactId?: string }[] {
    const prefix = `${nodeID}\u0000`;
    const found: { partId: string; domain: string; artifactId?: string }[] = [];

    for (const [entryKey, service] of running) {
        if (!entryKey.startsWith(prefix)) continue;
        const partId = entryKey.slice(prefix.length);
        if (partId.startsWith('core:')) continue;
        found.push({
            partId,
            domain: service.domain,
            ...(service.artifactId !== undefined ? { artifactId: service.artifactId } : {}),
        });
    }

    return found;
}
