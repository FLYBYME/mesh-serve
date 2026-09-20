/**
 * The domains the catalog part implements.
 *
 * Every other part's domain list is derived -- from its contracts at build time for a bundle, or
 * from the contract registry at load time. The catalog is the one exception, and for a structural
 * reason rather than an oversight: it owns `serve.corePart.load`, the contract that loads parts, so
 * it cannot be loaded through that path without already being loaded. `start.ts` mounts it
 * directly, and something has to tell it which domains to mount.
 *
 * Kept here rather than inline in `start.ts` so the list has one home, and so a test can hold it
 * against what the contracts actually declare (`test/unit/contracts/filePath.test.ts`) -- a new
 * catalog domain that nobody adds here would otherwise be silently absent from every booted node.
 */
export const CATALOG_DOMAINS = [
    'serve.repo',
    'serve.part',
    'serve.composition',
    'serve.artifact',
    'serve.release',
    'serve.corePart',
] as const;
