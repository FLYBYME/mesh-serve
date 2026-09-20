import fs from 'node:fs';
import path from 'node:path';

/**
 * Reads a part directory and works out, from its contracts alone, what mounting it requires: which
 * domains it implements, which modules have to be imported for those contracts to register, and
 * which exported function implements each non-CRUD action.
 *
 * This exists for the bundled case only. Unbundled, nothing needs precomputing -- the modules are
 * really at the paths the contracts declare, and `catalog/methods/resolveHandler.ts` imports them
 * directly. A bundle collapses those modules into one file, so the mapping has to be baked in at
 * build time; `buildCoreParts.ts` feeds this straight to esbuild as a synthesized entry module
 * rather than writing it into `src/`, because it is a build artifact and belongs in the build.
 *
 * Source text, not the loaded module: this runs inside the build, where importing a part's
 * contracts would mean evaluating them (and their transitive imports) in the build process.
 * The declarations being read are plain literals in the source, which is exactly the shape a
 * regex can read honestly.
 */

export interface PartHandler {
    toolKey: string;
    /** Absolute path to the module implementing it. */
    modulePath: string;
    exportName: string;
}

export interface PartContracts {
    /** Every domain this part's contracts declare, primary (shortest) first. */
    domains: string[];
    /** Absolute paths of the `*.contract.ts` modules; importing them is what registers the contracts. */
    contractModules: string[];
    handlers: PartHandler[];
}

function walk(dir: string): string[] {
    const found: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...walk(full));
        else if (entry.name.endsWith('.contract.ts')) found.push(full);
    }
    return found;
}

/**
 * Picks the exported function implementing `action` -- the build-time twin of
 * `resolveHandler.ts`'s `pickHandlerExport`, and deliberately the same rule: exact action match
 * first, then a module with exactly one exported function. 11 handlers here are named for their
 * collection *and* action (`identity.ticket.issue` -> `issueTicket`), because a flat `tools/`
 * directory cannot hold two files called `issue.ts`.
 *
 * Resolving it here means a name that does not exist fails the build, loudly, instead of failing
 * the first time that part is loaded on a node.
 */
function resolveExport(modulePath: string, action: string, declaredPath: string): string {
    if (!fs.existsSync(modulePath)) {
        throw new Error(`Contract handler not found: "${declaredPath}" (declared as the filePath for action "${action}").`);
    }

    const source = fs.readFileSync(modulePath, 'utf-8');
    const exported: string[] = [];
    for (const m of source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) exported.push(m[1]!);
    for (const m of source.matchAll(/export\s+const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/g)) exported.push(m[1]!);

    if (exported.includes(action)) return action;
    if (exported.length === 1) return exported[0]!;
    if (exported.length === 0) {
        throw new Error(`"${declaredPath}" exports no function, but is declared as the filePath for action "${action}".`);
    }
    throw new Error(`"${declaredPath}" exports ${exported.length} functions (${exported.join(', ')}) and none is named "${action}" -- rename the handler to match the action, or point filePath at a module with only it.`);
}

export function discoverPartContracts(partDir: string, packageRoot = process.cwd()): PartContracts {
    const contractModules = walk(partDir).sort();
    const domains = new Set<string>();
    const handlers: PartHandler[] = [];

    for (const module of contractModules) {
        const content = fs.readFileSync(module, 'utf-8');

        for (const match of content.matchAll(/export\s+const\s+\w+\s*=\s*defineContract\s*\(\s*\{([\s\S]*?)\}\s*\)\s*;/g)) {
            const body = match[1]!;
            const domain = /\bdomain\s*:\s*['"]([^'"]+)['"]/.exec(body)?.[1];
            const action = /\baction\s*:\s*['"]([^'"]+)['"]/.exec(body)?.[1];
            const declaredPath = /\bfilePath\s*:\s*['"]([^'"]+)['"]/.exec(body)?.[1];
            if (domain === undefined || action === undefined || declaredPath === undefined) continue;

            domains.add(domain);

            // A contract whose filePath still points at its own declaration file has no separate
            // handler module. Skipped rather than failing the build, so parts migrate one at a
            // time; loadDomain is what complains, and only for a part actually loaded this way.
            if (declaredPath.endsWith('.contract.ts')) continue;

            const modulePath = path.resolve(packageRoot, declaredPath);
            handlers.push({
                toolKey: `${domain}.${action}`,
                modulePath,
                exportName: resolveExport(modulePath, action, declaredPath),
            });
        }

        // defineCrud/defineTimeSeries contribute their domain but never a handler -- their actions
        // are intercepted by DatabaseMiddleware before dispatch.
        for (const match of content.matchAll(/export\s+const\s+\w+\s*=\s*define(?:Crud|TimeSeries)\s*\(\s*['"]([^'"]+)['"]/g)) {
            domains.add(match[1]!);
        }
    }

    return {
        // Shortest first: a part's primary domain is the one the others extend (`identity` before
        // `identity.user`), and that is what the loader reports as the part's identity.
        domains: Array.from(domains).sort((a, b) => a.length - b.length || a.localeCompare(b)),
        contractModules,
        handlers: handlers.sort((a, b) => a.toolKey.localeCompare(b.toolKey)),
    };
}
