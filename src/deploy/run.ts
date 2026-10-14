/**
 * `mesh-serve deploy`: one site file, onto the api the CLI is signed in to. What each site's own
 * scripts/deploy.mjs did (company site, cloud console -- the same steps copied per site with their
 * ids written in), once, read from the site file:
 *
 *   1. checks -- the checkout is clean and on its remote, the kernel is the mesh-web tag the site
 *      is pinned to, every generated client still matches its api, the site typechecks;
 *   2. the api, its exposures, the repos and parts made to match the file;
 *   3. each part built at an exact ref (this checkout's parts at the checked commit);
 *   4. the composition, and a release refused unless it holds exactly those builds;
 *   5. the site record (its head and pages) pointed at the release, and the live page looked at.
 *
 * A dry run by default: everything checked and said, nothing changed. Each deploy is appended to
 * `.deploys.jsonl` beside the site file -- the api keeps only the live release, so that file is how
 * to go back.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { loadSite, type PartSpec, type SiteSpec } from './spec.js';
import * as apply from './apply.js';
import { checkout, clients, kernel, localRepo, typecheck, type Check } from './checks.js';

const run = promisify(execFile);

export interface DeployOptions {
    readonly sitePath: string;
    readonly go: boolean;
    readonly force: boolean;
    readonly regenerate: boolean;
}

type Say = (line: string) => void;

/** The exact ref a part is built at: this checkout's parts at HEAD, a pin as given, a branch's tip as a commit. */
async function refOf(spec: SiteSpec, part: PartSpec, head: string | undefined): Promise<string> {
    if (part.ref !== undefined) return part.ref;

    const repo = spec.repos.find((r) => r.name === part.repo);
    if (repo === undefined) throw new Error(`No repo named "${part.repo}" for part "${part.key}".`);
    if (repo.local === true && head !== undefined) return head;

    const { stdout } = await run('git', ['ls-remote', repo.url, `refs/heads/${repo.ref}`]);
    const sha = stdout.split('\t')[0]?.trim() ?? '';

    // Not a branch: a tag, which does not move -- the builder resolves it.
    return sha !== '' ? sha : repo.ref;
}

function report(checks: readonly Check[], say: Say): number {
    for (const c of checks) say(`  ${c.ok ? 'ok' : '--'}  ${c.said}`);

    return checks.filter((c) => !c.ok).length;
}

export async function deploy(options: DeployOptions, say: Say): Promise<boolean> {
    const spec = loadSite(options.sitePath);
    const dir = path.dirname(path.resolve(options.sitePath));

    say(`> ${options.go ? 'Deploying' : 'Dry run'}: ${spec.site}, from ${options.sitePath}`);
    const api = await apply.connect();
    const tenantId = await apply.organization(api);
    say(`  through ${api.descriptor.host}, as organization ${tenantId}`);

    // ------------------------------------------------------------------ 1. checks
    say('> Checks');
    const { checks: gitChecks, head } = await checkout(dir, spec);
    const checks: Check[] = [
        ...gitChecks,
        ...(await kernel(dir, spec)),
        ...(await clients(dir, spec, { url: api.apiUrl, host: api.descriptor.host }, options.regenerate)),
        await typecheck(dir, spec),
    ];
    const unmet = report(checks, say);

    const before = await apply.findSite(api, spec, tenantId);
    say(before === undefined
        ? `  ${spec.site} is not a site yet: deploy makes it`
        : `  ${spec.site} serves ${before.application} @ ${before.releaseHash?.slice(0, 12) ?? '(nothing)'}`);

    const refs = new Map<string, string>();
    for (const part of spec.parts) refs.set(part.key, await refOf(spec, part, head));

    if (!options.go) {
        say('> Would');
        if (spec.api.expose === undefined) {
            say(`  leave ${spec.api.host}'s exposures as they are (the file lists none)`);
        } else {
            const existing = await apply.findApi(api, spec);
            const changes = existing === undefined ? [] : await apply.exposures(api, spec, existing, false);
            say(existing === undefined
                ? `  make ${spec.api.host} with the file's ${spec.api.expose.length} exposure(s)`
                : `  change ${changes.length} of ${spec.api.host}'s exposures${changes.length > 0 ? ':' : ''}`);
            for (const c of changes) say(`    ${c.change} ${c.contract}`);
        }
        for (const part of spec.parts) say(`  build ${part.key} at ${refs.get(part.key)?.slice(0, 12) ?? '?'}`);
        say(`  compose, deploy to ${spec.site} with ${spec.pages.length} page(s), and look at the live page`);
        say(unmet === 0 ? '\nReady: mesh-serve deploy --go' : `\nBefore --go: ${unmet} check(s) above to fix.`);

        return unmet === 0;
    }
    if (unmet > 0) throw new Error(`Not deploying: ${unmet} check(s) failed.`);

    // ------------------------------------------------------------------ 2. the api and the catalog
    say('> The api and its exposures');
    const siteApi = await apply.siteApi(api, spec, tenantId);
    say(`  ${spec.api.host}: ${siteApi.made ? 'made' : 'there'} (${siteApi.id})`);

    const changed = await apply.exposures(api, spec, siteApi.id, true);
    for (const c of changed) say(`  ${c.change} ${c.contract}`);
    if (changed.length > 0) {
        // The api's shape moved with them: its clients are checked again against what it is now.
        const again = await clients(dir, spec, { url: api.apiUrl, host: api.descriptor.host }, false);
        if (report(again, say) > 0) throw new Error('The exposures changed the api: regenerate its clients, commit, and deploy again.');
    }

    say('> Repos and parts');
    const repoIds = await apply.repos(api, spec, tenantId);
    const parts = await apply.parts(api, spec, tenantId, repoIds);

    // ------------------------------------------------------------------ 3. builds
    say('> Builds');
    const builds: apply.Artifact[] = [];
    for (const part of parts) {
        const ref = refs.get(part.key);
        if (ref === undefined) throw new Error(`No ref for ${part.key}.`);

        const built = await apply.build(api, tenantId, part, ref, options.force, (line) => say(`  ${line}`));
        const local = localRepo(spec);
        const fromHere = local !== undefined && spec.parts.find((p) => p.key === part.key)?.repo === local.name;
        if (fromHere && head !== undefined && built.commit !== undefined && built.commit !== head) {
            throw new Error(`${part.key} was built from ${built.commit.slice(0, 7)}, not the checked ${head.slice(0, 7)}.`);
        }

        builds.push(built);
    }

    // ------------------------------------------------------------------ 4. the release
    say('> The release');
    const composition = await apply.composition(api, tenantId, parts);
    // compose takes each part's newest successful build, and services are never in a release: the
    // release must hold exactly the page's builds deploy just made or found.
    const paged = builds.filter((_, i) => parts[i]?.kind !== 'service' && parts[i]?.kind !== 'driver');
    const release = await apply.release(api, composition.id, paged);
    say(`  release ${release.id} of ${composition.key}`);

    // ------------------------------------------------------------------ 5. deploy, and look
    say(`> Deploying to ${spec.site}`);
    const deployed = await apply.site(api, spec, tenantId, siteApi.id, composition.key, before, release.id);
    say(`  ${deployed.host} now serves ${deployed.application} @ ${deployed.releaseHash?.slice(0, 12) ?? '?'}`);

    await fs.appendFile(path.join(dir, '.deploys.jsonl'), `${JSON.stringify({
        at: new Date().toISOString(), site: spec.site, api: api.descriptor.host, commit: head,
        releaseId: release.id, releaseHash: deployed.releaseHash, replacedHash: before?.releaseHash,
    })}\n`);

    if (spec.site.endsWith('.localhost')) {
        say(`  ${spec.site} is local: not looked at`);
        return true;
    }

    const page = await fetch(`https://${spec.site}/`, { headers: { 'cache-control': 'no-cache' } }).then((r) => r.text()).catch(() => '');
    const serving = page.includes(`application: "${composition.key}"`);
    say(`  the live page boots ${composition.key}: ${serving ? 'yes' : 'NO'}`);
    say(`To go back: mesh-serve serve.cdn.deploy --siteId ${deployed.id} --releaseId <an earlier releaseId in .deploys.jsonl>`);

    return serving;
}
