/**
 * Which builds' files the database keeps -- pure.
 *
 * Every build's files are stored in the database (artifactStore.ts, GridFS bucket artifactFiles)
 * and nothing ever removed one: on 2026-10-01 they were 124 MB of a 512 MB Atlas tier -- the
 * largest thing in it -- when the database filled and every write on the platform stopped.
 *
 * Kept, by content hash:
 * - every build a part is pinned to (what runs now);
 * - each part's newest KEEP_PER_PART successful builds (what a rollback goes back to);
 * - every build in each composition's newest KEEP_RELEASES releases (what a site rollback, from
 *   .deploys.jsonl, goes back to);
 * - any build finished in the last KEEP_RECENT_MS (just built, not yet pinned or released).
 * Everything else's files go; its record stays, so the history is still there to read. A node
 * that has the files on its own disk still serves them; a build whose files are gone everywhere
 * is rebuilt from its commit if it is ever wanted again.
 */
export const KEEP_PER_PART = 3;
export const KEEP_RELEASES = 3;
// An hour, not a day: a build is pinned or released within minutes of finishing, and a day's
// window kept every build of a busy day -- 84 of them, the database 83% full again (2026-10-01).
export const KEEP_RECENT_MS = 3600_000;

export interface RetentionArtifact {
    readonly id: string;
    readonly partId: string;
    readonly status: string;
    readonly hash?: string;
    readonly updatedAt: Date;
}

export interface RetentionInput {
    readonly parts: ReadonlyArray<{ readonly artifactId?: string }>;
    readonly artifacts: readonly RetentionArtifact[];
    readonly releases: ReadonlyArray<{ readonly compositionId: string; readonly createdAt: Date; readonly artifacts: ReadonlyArray<{ readonly hash?: string }> }>;
    readonly now: Date;
}

export function hashesToKeep(input: RetentionInput): Set<string> {
    const keep = new Set<string>();
    const add = (h: string | undefined): void => {
        if (h !== undefined && h !== '') keep.add(h);
    };
    const byId = new Map(input.artifacts.map((a) => [a.id, a]));

    for (const part of input.parts) if (part.artifactId !== undefined) add(byId.get(part.artifactId)?.hash);

    const perPart = new Map<string, RetentionArtifact[]>();
    for (const a of input.artifacts) {
        if (a.status !== 'success' || a.hash === undefined) continue;
        perPart.set(a.partId, [...(perPart.get(a.partId) ?? []), a]);
        if (input.now.getTime() - a.updatedAt.getTime() < KEEP_RECENT_MS) add(a.hash);
    }
    for (const list of perPart.values()) {
        for (const a of [...list].sort((x, y) => y.updatedAt.getTime() - x.updatedAt.getTime()).slice(0, KEEP_PER_PART)) add(a.hash);
    }

    const perComposition = new Map<string, RetentionInput['releases'][number][]>();
    for (const r of input.releases) perComposition.set(r.compositionId, [...(perComposition.get(r.compositionId) ?? []), r]);
    for (const list of perComposition.values()) {
        for (const r of [...list].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime()).slice(0, KEEP_RELEASES)) {
            for (const a of r.artifacts) add(a.hash);
        }
    }
    return keep;
}

/** The stored hashes whose files go: stored, and not kept. */
export function hashesToDrop(stored: Iterable<string>, keep: ReadonlySet<string>): string[] {
    return [...new Set(stored)].filter((h) => !keep.has(h)).sort();
}
