/**
 * A site spec loader: what sync.ts provisions a site from. Data lives in a hand-editable file --
 * no TS toolchain needed to change a repo url or add a part -- validated on load against
 * console.site.schema.ts's real zod schema, so a malformed edit fails loudly here, with a real
 * path to the bad field, instead of surfacing as a confusing broker.call error three steps into
 * provisioning.
 *
 * YAML is the hand-written format, chosen deliberately: this file is where a gate on an exposed
 * contract, or why a part exists at all, needs to be said in prose next to the field it explains --
 * something JSON cannot hold and a separate doc would drift from. JSON is still read (by
 * extension), because a *machine*-written site spec -- dumping what is actually running, for a
 * diff against what is declared -- goes to JSON: no YAML serializer round-trips comments, and
 * comments are the entire reason this format was chosen for the hand-written side.
 *
 * The path itself used to be hardcoded here, meaning switching which site sync.ts provisioned
 * meant hand-editing this file instead of passing an argument -- DEFAULT_SITE_PATH keeps the
 * original console site as the zero-argument default, and callers needing a different site now
 * pass `--site` to sync.ts instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { siteSpecSchema, type SiteSpec } from './console.site.schema.js';

export type { RepoSpec, PartSpec, PartSpecKind, ExposeSpec, SiteSpec } from './console.site.schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The operator console's own site: console.localhost/console-api.localhost. */
export const DEFAULT_SITE_PATH = path.join(here, 'console.site.yaml');

export function loadSite(sitePath: string): SiteSpec {
    const raw = fs.readFileSync(sitePath, 'utf-8');
    const parsed: unknown = sitePath.endsWith('.json') ? JSON.parse(raw) : YAML.parse(raw);
    return siteSpecSchema.parse(parsed);
}
