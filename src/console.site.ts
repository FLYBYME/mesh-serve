/**
 * A site spec loader: what sync.ts (and its non-idempotent predecessor, details.ts) provisions a
 * site from. Data lives in a hand-editable JSON file -- no TS toolchain needed to change a repo
 * url or add a part -- validated on load against console.site.schema.ts's real zod schema, so a
 * malformed edit fails loudly here, with a real path to the bad field, instead of surfacing as a
 * confusing broker.call error three steps into provisioning.
 *
 * The path itself used to be hardcoded here, meaning switching which site sync.ts provisioned
 * meant hand-editing this file instead of passing an argument -- DEFAULT_SITE_PATH keeps the
 * original console.site.json as the zero-argument default, and callers needing a different site
 * (or, historically, a different site entirely by editing this constant) now pass `--site` to
 * sync.ts instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { siteSpecSchema, type SiteSpec } from './console.site.schema.js';

export type { RepoSpec, PartSpec, PartSpecKind, SiteSpec } from './console.site.schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The operator console's own site: console.localhost/console-api.localhost. */
export const DEFAULT_SITE_PATH = path.join(here, 'console.site.json');

export function loadSite(sitePath: string): SiteSpec {
    const raw = JSON.parse(fs.readFileSync(sitePath, 'utf-8'));
    return siteSpecSchema.parse(raw);
}
