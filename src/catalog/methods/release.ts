import crypto from 'node:crypto';

import type { ReleaseArtifact } from '../contracts/release.contract.js';

/**
 * The one place this gets computed -- compose.ts and CatalogService's serve.release.create
 * before-hook both call this instead of each hand-rolling the same sha256, so a caller minting
 * their own release (bypassing compose entirely, pinning specific artifacts) still produces a
 * hash that means the same thing as compose's. Hashed by artifact id, not the whole embedded row
 * (hash/assets/etc) -- an artifact is immutable once built, so its id alone already pins its content.
 */
export function computeReleaseHash(compositionId: string, artifacts: readonly ReleaseArtifact[]): string {
    return crypto.createHash('sha256')
        .update(JSON.stringify({ compositionId, artifactIds: artifacts.map((a) => a.id).sort() }))
        .digest('hex');
}
