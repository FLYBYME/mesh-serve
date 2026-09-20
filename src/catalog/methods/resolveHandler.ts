import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import type { ToolContract } from '@flybyme/mesh';

/**
 * `loadDomain`'s handler resolver for the unbundled case: import the module a contract's
 * `filePath` names, and return the export that implements it.
 *
 * This is the half that needs no build step. A contract already says where its code lives, so when
 * that file genuinely exists on disk -- running from source under tsx/vitest, or from `dist/` in an
 * ordinary install -- nothing has to be generated, listed or kept in step. A precompiled bundle is
 * the one case this cannot serve, because bundling collapses those modules into a single file;
 * there, `buildCoreParts` supplies a prebuilt map instead. Both read the same declaration.
 */

function findPackageRoot(startDir: string): string {
    let dir = startDir;
    for (;;) {
        if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) {
            throw new Error(`Could not locate mesh-serve's package root walking up from "${startDir}".`);
        }
        dir = parent;
    }
}

const PACKAGE_ROOT = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));

/**
 * A contract declares its handler as a repo-relative source path (`src/hold/tools/decide.ts`),
 * which is the honest thing for it to say -- but the running process may be the compiled build,
 * where that module is `dist/hold/tools/decide.js`. Both are tried, source first, because running
 * from source is the case where being wrong is silent: `dist/` may hold a stale copy of the same
 * module and would load without complaint.
 */
export function handlerCandidates(filePath: string): string[] {
    const fromSource = path.join(PACKAGE_ROOT, filePath);
    const compiled = filePath.startsWith('src/')
        ? path.join(PACKAGE_ROOT, 'dist', filePath.slice('src/'.length).replace(/\.ts$/, '.js'))
        : undefined;

    return compiled === undefined ? [fromSource] : [fromSource, compiled];
}

/**
 * Picks the exported function implementing `action`.
 *
 * An exact match on the action name wins. Failing that, a module exporting exactly one function is
 * unambiguous and is taken: 11 handlers here are named for their collection *and* action
 * (`identity.ticket.issue` -> `issueTicket`), because a flat `tools/` directory cannot hold two
 * files called `issue.ts`. Anything else is genuinely ambiguous and says so rather than guessing.
 */
export function pickHandlerExport(
    module: Record<string, unknown>,
    action: string,
    filePath: string,
): (params: never, ctx: never) => Promise<unknown> {
    const direct = module[action];
    if (typeof direct === 'function') return direct as (params: never, ctx: never) => Promise<unknown>;

    const functions = Object.entries(module).filter(([, value]) => typeof value === 'function');
    if (functions.length === 1) return functions[0]![1] as (params: never, ctx: never) => Promise<unknown>;

    const names = functions.map(([name]) => name);
    throw new Error(
        names.length === 0
            ? `"${filePath}" exports no function, but a contract declares it as the implementation of "${action}".`
            : `"${filePath}" exports ${names.length} functions (${names.join(', ')}) and none is named "${action}" -- rename the handler to match the action, or point filePath at a module with only it.`,
    );
}

export async function resolveHandler(contract: ToolContract): Promise<unknown> {
    const candidates = handlerCandidates(contract.filePath);
    const found = candidates.find((candidate) => fs.existsSync(candidate));

    if (found === undefined) {
        throw new Error(
            `Handler for "${contract.domain}.${contract.action}" not found. Its contract declares filePath "${contract.filePath}"; looked for ${candidates.map((c) => `"${c}"`).join(' and ')}.`,
        );
    }

    const module = await import(pathToFileURL(found).href) as Record<string, unknown>;
    return pickHandlerExport(module, contract.action, contract.filePath);
}
