import { Command } from 'commander';
import { BaseCommand } from '../core/BaseCommand.js';
import fs from 'fs';
import path from 'path';

interface ContractDiscovery {
    exportName: string;
    domain: string;
    action: string;
    description: string;
    method: string;
    path: string;
    isStream: boolean;
    /** The `*.contract.ts` this was declared in. */
    filePath: string;
    /** The contract's own declared `filePath` -- where its *handler* lives. */
    handlerPath: string;
}

interface EventDiscovery {
    exportName: string;
    name: string; // The event string (e.g., 'demo.hello.sent')
    filePath: string;
}

interface CrudDiscovery {
    exportName: string; // the defineCrud export itself, e.g. 'userCrud' -- not dotted with an action
    domain: string;
    filePath: string;
}

/**
 * Turn the *source text* of a string literal back into the value it denotes.
 *
 * Descriptions are read by matching source rather than by parsing it, so what comes back is what was
 * typed: `a site\'s parts`, with the backslash still in it. Emitting that verbatim is how a value
 * ending in a backslash escapes the delimiter of whatever literal it is written into.
 *
 * Only the escapes that appear in hand-written prose are handled. A description written with a
 * numeric or unicode escape is not a case worth a parser for.
 */
export function unescapeStringLiteral(raw: string): string {
    return raw.replace(/\\(.)/g, (_, char: string) => {
        switch (char) {
            case 'n': return '\n';
            case 't': return '\t';
            case 'r': return '\r';
            // `\'`, `\"`, `` \` `` and `\\` all denote the character itself.
            default: return char;
        }
    });
}

/**
 * A template literal that safely holds arbitrary text.
 *
 * Three characters can escape a template literal, and all three occur in ordinary prose: a backtick,
 * a backslash, and `${`. Escaping them here is what makes the emitted file parse regardless of what
 * a contract author wrote — the check that does not depend on remembering a rule.
 */
export function toTemplateLiteral(value: string): string {
    const escaped = value
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\$\{/g, '\\${');
    return `\`${escaped}\``;
}

/**
 * GenerateCommand: Core Generator for Mesh Architecture.
 */
export class GenerateCommand extends BaseCommand {
    public readonly name = 'generate';
    public readonly description = 'Generate strictly-typed artifacts (IServiceToolRegistry, EventRegistry) from this project\'s own contracts.';
    public override readonly category = 'System Tools';

    private readonly artifactRoot = path.resolve('./src/generated');

    public register(program: Command): void {
        program
            .command(this.name)
            .description(this.description)
            .option('--dir <dir>', 'Directory to scan for contracts', './src')
            .option('--out <dir>', 'Output directory for generated files', './src/generated')
            .option('-I, --include <paths...>', 'Paths or Package Names of external generated api.ts files to include in this project\'s types')
            .action(async (options: { dir?: string, out?: string, include?: string[] }) => {
                await this.execute(options);
            });
    }

    public async execute(options: { dir?: string, out?: string, include?: string[] } = {}): Promise<void> {
        const scanDir = path.resolve(options.dir || './src');
        if (!fs.existsSync(scanDir)) {
            throw new Error(`Directory not found: ${scanDir}`);
        }

        const artifactRoot = path.resolve(options.out || this.artifactRoot);

        this.logger.info(`--- Generating Mesh Artifacts from ${scanDir} ---`);
        const start = Date.now();

        if (!fs.existsSync(artifactRoot)) {
            fs.mkdirSync(artifactRoot, { recursive: true });
        }

        const { discovery, events, cruds, files } = this.discoverContractsAndEvents([scanDir]);

        await this.generateToolRegistry(discovery, files, options.include || [], artifactRoot);
        await this.generateEvents(events, discovery, files, options.include || [], artifactRoot);
        await this.generateCollectionRegistry(cruds, files, options.include || [], artifactRoot);
        await this.generateHandlerManifests(discovery, scanDir);

        this.logger.info('--- Generation Complete ---');
        const end = Date.now();
        this.logger.info(`Generation completed in ${(end - start) / 1000} seconds`);
    }

    private async generateToolRegistry(discovery: ContractDiscovery[], files: Record<string, string[]>, includes: string[], artifactRoot: string = this.artifactRoot): Promise<void> {
        this.logger.info('Generating IServiceToolRegistry augmentation...');
        const filePath = path.join(artifactRoot, 'api.ts');
        const aliasMap = this.getAliasMap(files, artifactRoot);

        let code = `// GENERATED FILE - DO NOT EDIT\n`;
        code += `import { z } from 'zod';\n`;

        if (includes.length > 0) {
            code += `\n// External Type Includes\n`;
            for (const includePath of includes) {
                if (!includePath.startsWith('.') && !includePath.startsWith('/') && !includePath.includes('\\')) {
                    code += `import '${includePath}';\n`;
                } else {
                    const absoluteInclude = path.resolve(includePath);
                    let rel = path.relative(artifactRoot, absoluteInclude).replace(/\\/g, '/');
                    if (!rel.startsWith('.')) rel = './' + rel;
                    code += `import '${rel}';\n`;
                }
            }
        }

        Object.values(aliasMap).forEach(m => {
            code += `import * as ${m.alias} from '${m.path}';\n`;
        });

        code += `\ndeclare global {\n`;
        code += `    interface IServiceToolRegistry {\n`;

        const seenTools = new Set<string>();
        for (const m of discovery) {
            const toolKey = `${m.domain}.${m.action}`;
            if (seenTools.has(toolKey)) continue;
            seenTools.add(toolKey);

            const alias = aliasMap[m.filePath]?.alias;
            if (!alias) continue;

            let inputType = 'unknown', outputType = 'unknown';

            if (m.exportName.includes('.')) {
                const [c, k] = m.exportName.split('.');
                inputType = `z.input<typeof ${alias}.${c}['${k}']['inputSchema']>`;
                outputType = `z.infer<typeof ${alias}.${c}['${k}']['outputSchema']>`;
            } else {
                inputType = `z.input<typeof ${alias}.${m.exportName}['inputSchema']>`;
                outputType = `z.infer<typeof ${alias}.${m.exportName}['outputSchema']>`;
            }

            code += `        '${m.domain}.${m.action}': { params: ${inputType}, returns: ${outputType} };\n`;
        }

        code += `    }\n}\n`;
        code += `\nexport type { IServiceToolRegistry };\n`;
        fs.writeFileSync(filePath, code);
    }

    private async generateEvents(events: EventDiscovery[], discovery: ContractDiscovery[], files: Record<string, string[]>, includes: string[], artifactRoot: string = this.artifactRoot): Promise<void> {
        this.logger.info('Generating EventRegistry augmentation...');
        const filePath = path.join(artifactRoot, 'events.ts');
        const aliasMap = this.getAliasMap(files, artifactRoot);

        let code = `// GENERATED FILE - DO NOT EDIT\n`;
        code += `import { z } from 'zod';\n`;

        if (includes.length > 0) {
            code += `\n// External Type Includes\n`;
            for (const includePath of includes) {
                if (!includePath.startsWith('.') && !includePath.startsWith('/') && !includePath.includes('\\')) {
                    code += `import '${includePath}';\n`;
                    continue;
                }

                let target = includePath;
                if (includePath.endsWith('api.ts') || includePath.endsWith('api.js')) {
                    target = includePath.replace(/api\.(ts|js)$/, 'events.$1');
                }

                if (fs.existsSync(path.resolve(target))) {
                    const absoluteInclude = path.resolve(target);
                    let rel = path.relative(artifactRoot, absoluteInclude).replace(/\\/g, '/');
                    if (!rel.startsWith('.')) rel = './' + rel;
                    code += `import '${rel}';\n`;
                }
            }
        }

        Object.values(aliasMap).forEach(m => {
            code += `import * as ${m.alias} from '${m.path}';\n`;
        });

        code += `\ndeclare global {\n`;
        code += `    interface EventRegistry {\n`;

        for (const e of events) {
            const fileMapping = aliasMap[e.filePath];
            if (fileMapping) {
                const schemaType = `typeof ${fileMapping.alias}.${e.exportName}['schema']`;
                code += `        '${e.name}': z.infer<${schemaType}>;\n`;
            }
        }

        // Additive, backward-compatible companions to the generic `data.created`/
        // `data.updated`/`data.deleted` events every CRUD write already fires (see
        // DatabaseMiddleware.ts's `emitNamed`) -- one `<domain>.created`/`.updated`/
        // `.deleted` entry per CRUD-mounted domain, typed off that domain's own
        // create/update contract schemas rather than the generic `data.*` shape.
        const namedCrudEvents = new Set<string>();
        for (const m of discovery) {
            if (!['create', 'update', 'delete'].includes(m.action)) continue;
            if (!m.exportName.includes('.')) continue; // only CRUD-derived entries are dotted
            if (namedCrudEvents.has(m.domain)) continue;

            const alias = aliasMap[m.filePath]?.alias;
            if (!alias) continue;

            const [crudExport] = m.exportName.split('.');
            namedCrudEvents.add(m.domain);

            const createdType = `z.infer<typeof ${alias}.${crudExport}['create']['outputSchema']>`;
            const updatedItemType = `z.infer<typeof ${alias}.${crudExport}['update']['outputSchema']>`;

            code += `        '${m.domain}.created': ${createdType};\n`;
            code += `        '${m.domain}.updated': { id: string; patch: Record<string, unknown>; item: ${updatedItemType} };\n`;
            code += `        '${m.domain}.deleted': { id: string };\n`;
        }

        code += `    }\n}\n`;
        code += `\nexport type { EventRegistry };\n`;
        fs.writeFileSync(filePath, code);
    }

    /**
     * Generates `IServiceCollectionRegistry`: one entry per `defineCrud`'d domain, typed off that
     * export's own `outputSchema` -- the *full* record shape (`hidden` fields included), not any of
     * the ten generated actions' own `returns` (every one of those types off `publicOutputSchema`,
     * the stripped view a generic caller gets). `Database.collection(domain)` (mesh core) is the
     * consumer: it validates every read/write against `globalCrudRegistry.get(domain).outputSchema`
     * at runtime -- the literal same schema this reads `z.infer<>` off here, so the declared type and
     * the runtime validator can never drift apart the way two independently-asserted types could.
     */
    private async generateCollectionRegistry(cruds: CrudDiscovery[], files: Record<string, string[]>, includes: string[], artifactRoot: string = this.artifactRoot): Promise<void> {
        this.logger.info('Generating IServiceCollectionRegistry augmentation...');
        const filePath = path.join(artifactRoot, 'collections.ts');
        const aliasMap = this.getAliasMap(files, artifactRoot);

        let code = `// GENERATED FILE - DO NOT EDIT\n`;
        code += `import { z } from 'zod';\n`;

        if (includes.length > 0) {
            code += `\n// External Type Includes\n`;
            for (const includePath of includes) {
                if (!includePath.startsWith('.') && !includePath.startsWith('/') && !includePath.includes('\\')) {
                    code += `import '${includePath}';\n`;
                } else {
                    const absoluteInclude = path.resolve(includePath);
                    let rel = path.relative(artifactRoot, absoluteInclude).replace(/\\/g, '/');
                    if (!rel.startsWith('.')) rel = './' + rel;
                    code += `import '${rel}';\n`;
                }
            }
        }

        Object.values(aliasMap).forEach(m => {
            code += `import * as ${m.alias} from '${m.path}';\n`;
        });

        code += `\ndeclare global {\n`;
        code += `    interface IServiceCollectionRegistry {\n`;

        for (const c of cruds) {
            const alias = aliasMap[c.filePath]?.alias;
            if (!alias) continue;

            code += `        '${c.domain}': z.infer<typeof ${alias}.${c.exportName}['outputSchema']>;\n`;
        }

        code += `    }\n}\n`;
        code += `\nexport type { IServiceCollectionRegistry };\n`;
        fs.writeFileSync(filePath, code);
    }

    /**
     * Finds the exported function a contract's `filePath` points at.
     *
     * The export name is resolved here, at build time, rather than declared on the contract as a
     * string. A string export name in hand-written source is unverifiable -- nothing type-checks
     * it, and getting it wrong fails at load. Resolved here it becomes ordinary generated code
     * that `tsc` checks like any other import, so a wrong name is a compile error.
     *
     * Preference order matters: 11 of the handlers in this codebase are named for the collection
     * *and* the action (`identity.ticket.issue` -> `issueTicket`) because a flat `tools/` directory
     * cannot hold two files called `issue.ts`. So an exact `action` match wins, and a module with
     * exactly one exported function falls back to it. Anything else is ambiguous and says so.
     */
    private resolveHandlerExport(handlerPath: string, action: string): string {
        const absolute = path.resolve(handlerPath);
        if (!fs.existsSync(absolute)) {
            throw new Error(`Contract handler not found: "${handlerPath}" (declared as filePath for action "${action}"). A contract's filePath must point at the module implementing it.`);
        }

        const source = fs.readFileSync(absolute, 'utf-8');
        const exported: string[] = [];
        for (const m of source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) exported.push(m[1]!);
        for (const m of source.matchAll(/export\s+const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/g)) exported.push(m[1]!);

        if (exported.includes(action)) return action;
        if (exported.length === 1) return exported[0]!;
        if (exported.length === 0) {
            throw new Error(`"${handlerPath}" exports no function, but is declared as the filePath for action "${action}".`);
        }
        throw new Error(`"${handlerPath}" exports ${exported.length} functions (${exported.join(', ')}) and none is named "${action}" -- rename the handler to match the action, or point filePath at a module with only it.`);
    }

    /**
     * Emits one `handlers.generated.ts` per part -- the handler map `broker.loadDomain` takes.
     *
     * This is what replaces a hand-written `register(broker)`. That function listed, by hand, a
     * contract-to-handler mapping the contracts already declare; this derives the same mapping from
     * those declarations. Nobody writes or maintains it, and it cannot drift from the contracts
     * because it is regenerated from them.
     *
     * A part is a top-level directory under `src/`, not a domain, because the two are not the same
     * thing: `catalog/` owns six domains (`serve.repo`, `serve.part`, `serve.release`, ...) whose
     * only common prefix is `serve`, which every other part shares too. So the manifest states its
     * domains explicitly rather than having the loader guess one.
     *
     * The map's values are thunks -- `() => import('./tools/decide.js').then(m => m.decide)` --
     * which a bundler inlines and an unbundled runtime resolves from real files, so the same
     * generated file works precompiled or not.
     */
    private async generateHandlerManifests(discovery: ContractDiscovery[], scanDir: string): Promise<void> {
        this.logger.info('Generating per-part handler manifests...');

        // Grouped over *every* contract, not only those with handlers: a part's domain list and
        // its contract-module imports have to cover its CRUD collections too, or loadDomain would
        // find half a domain registered.
        const byPart = new Map<string, ContractDiscovery[]>();
        for (const c of discovery) {
            const partDir = path.relative(scanDir, path.dirname(c.filePath)).split(path.sep)[0];
            if (partDir === undefined || partDir === '') continue;
            const list = byPart.get(partDir) ?? [];
            list.push(c);
            byPart.set(partDir, list);
        }

        for (const [partDir, contracts] of byPart) {
            const outDir = path.join(scanDir, partDir);
            const outPath = path.join(outDir, 'handlers.generated.ts');
            const relative = (target: string): string => {
                let rel = path.relative(outDir, path.resolve(target)).replace(/\\/g, '/');
                if (!rel.startsWith('.')) rel = './' + rel;
                return rel.replace(/\.ts$/, '.js');
            };

            // Shortest first: a part's primary domain is the one the others extend
            // (`identity` before `identity.user`), and that is what the loader reports.
            const domains = Array.from(new Set(contracts.map((c) => c.domain)))
                .sort((a, b) => a.length - b.length || a.localeCompare(b));

            // A custom contract whose filePath still points at its own declaration file has no
            // handler to find. Skipped rather than failing the build, so parts migrate one at a
            // time; loadDomain is what complains, and only for a part actually loaded this way.
            const withHandlers = contracts
                .filter((c) => c.handlerPath !== '' && !c.handlerPath.endsWith('.contract.ts'))
                .sort((a, b) => `${a.domain}.${a.action}`.localeCompare(`${b.domain}.${b.action}`));

            const contractModules = Array.from(new Set(contracts.map((c) => c.filePath))).sort();

            let code = '// GENERATED FILE - DO NOT EDIT\n';
            code += '//\n';
            code += "// This part's handler map, derived from each contract's own declared filePath.\n";
            code += '// Hand-written registration -- a register(broker) listing every contract one at a\n';
            code += '// time -- is what this replaces. See docs/CONTRACT_DRIVEN_PLACEMENT.md.\n';
            code += "import type { ContractHandlerMap } from '@flybyme/mesh';\n\n";
            code += '// Side-effect imports: evaluating a contract module is what registers its contracts\n';
            code += '// with globalContractRegistry, which is where loadDomain reads them from.\n';
            for (const module of contractModules) {
                code += `import '${relative(module)}';\n`;
            }
            code += '\n/** Every domain whose contracts this part implements, primary first. */\n';
            code += `export const domains = [${domains.map((d) => `'${d}'`).join(', ')}] as const;\n\n`;
            code += '/** Tool key -> the handler its contract points at. CRUD actions need none. */\n';
            code += 'export const handlers: ContractHandlerMap = {\n';

            for (const c of withHandlers) {
                const exportName = this.resolveHandlerExport(c.handlerPath, c.action);
                code += `    '${c.domain}.${c.action}': () => import('${relative(c.handlerPath)}').then((m) => m.${exportName}),\n`;
            }

            code += '};\n';
            fs.writeFileSync(outPath, code);
        }
    }

    private discoverContractsAndEvents(dirsToScan: string[]): { discovery: ContractDiscovery[], events: EventDiscovery[], cruds: CrudDiscovery[], files: Record<string, string[]> } {
        const allContracts: ContractDiscovery[] = [];
        const allEvents: EventDiscovery[] = [];
        const allCruds: CrudDiscovery[] = [];
        const domainFiles: Record<string, string[]> = {};

        const scanFiles: string[] = [];
        for (const dir of dirsToScan) {
            if (fs.existsSync(dir)) {
                scanFiles.push(...this.walkDir(dir).filter(f => f.endsWith('.contract.ts')));
            }
        }

        for (const file of scanFiles) {
            const content = fs.readFileSync(file, 'utf-8');

            // 1. Hardened defineContract parser
            const contractMatches = content.matchAll(/export\s+const\s+(\w+)\s*=\s*defineContract\s*\(\s*\{([\s\S]*?)\}\s*\)\s*;/g);
            for (const match of contractMatches) {
                const exportName = match[1]!;
                const body = match[2]!;

                const domainMatch = /\bdomain\s*:\s*['"]([^'"]+)['"]/.exec(body);
                const actionMatch = /\baction\s*:\s*['"]([^'"]+)['"]/.exec(body);
                // `(?:[^'\\]|\\.)*` rather than `[^']+`: a quote may be escaped inside the string it
                // delimits, and stopping at the first `'` in `'a site\'s parts'` captures
                // `a site\` — a value ending in a backslash, which then escapes the closing backtick
                // of whatever template literal it is emitted into. See `unescape` below.
                const descMatch = /\bdescription\s*:\s*'((?:[^'\\]|\\.)*)'/.exec(body)
                    || /\bdescription\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body)
                    || /\bdescription\s*:\s*`((?:[^`\\]|\\.)*)`/.exec(body);
                const restMatch = /\brest\s*:\s*\{([\s\S]*?)\}/.exec(body);
                const handlerPathMatch = /\bfilePath\s*:\s*['"]([^'"]+)['"]/.exec(body);

                let method = 'POST';
                let pathStr = '/';
                let isStream = false;

                if (restMatch) {
                    const restBody = restMatch[1]!;
                    const m = /\bmethod\s*:\s*['"]([^'"]+)['"]/.exec(restBody);
                    const p = /\bpath\s*:\s*['"]([^'"]+)['"]/.exec(restBody);
                    const s = /\bisStream\s*:\s*(true|false)/.exec(restBody);
                    if (m) method = m[1]!;
                    if (p) pathStr = p[1]!;
                    if (s) isStream = s[1] === 'true';
                }

                if (domainMatch && actionMatch) {
                    const domain = domainMatch[1]!;
                    const action = actionMatch[1]!;

                    if (domain.includes('_')) throw new Error(`Domain "${domain}" cannot contain underscores (File: ${file})`);

                    if (!domainFiles[domain]) domainFiles[domain] = [];
                    if (!domainFiles[domain].includes(file)) domainFiles[domain].push(file);

                    allContracts.push({
                        exportName,
                        domain,
                        action,
                        description: descMatch ? unescapeStringLiteral(descMatch[1] ?? '') : '',
                        method,
                        path: pathStr,
                        isStream,
                        filePath: file,
                        handlerPath: handlerPathMatch ? handlerPathMatch[1]! : ''
                    });
                }
            }

            // 2. defineCrud Parser
            const crudMatches = content.matchAll(/export\s+const\s+(\w+)\s*=\s*defineCrud\s*\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)/g);
            for (const match of crudMatches) {
                const exportName = match[1]!;
                const domain = match[2]!;

                if (domain.includes('_')) throw new Error(`Domain "${domain}" cannot contain underscores (File: ${file})`);

                const actions = { create: 'create', find: 'find', findOne: 'find_one', count: 'count', get: 'get', resolve: 'resolve', update: 'update', delete: 'delete' };

                if (!domainFiles[domain]) domainFiles[domain] = [];
                if (!domainFiles[domain].includes(file)) domainFiles[domain].push(file);

                allCruds.push({ exportName, domain, filePath: file });

                Object.entries(actions).forEach(([key, action]) => {
                    allContracts.push({
                        exportName: `${exportName}.${key}`,
                        domain,
                        action,
                        description: `CRUD ${key} for ${domain} (${exportName})`,
                        method: 'POST',
                        path: `/${domain}/${action}`,
                        isStream: false,
                        filePath: file,
                        // A generated CRUD/time-series action has no handler module: DatabaseMiddleware
                        // intercepts it before dispatch. loadDomain knows this from isCrud.
                        handlerPath: ''
                    });
                });
            }

            // 3. defineTimeSeries Parser
            const tsMatches = content.matchAll(/export\s+const\s+(\w+)\s*=\s*defineTimeSeries\s*\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)/g);
            for (const match of tsMatches) {
                const exportName = match[1]!;
                const domain = match[2]!;

                if (domain.includes('_')) throw new Error(`Domain "${domain}" cannot contain underscores (File: ${file})`);

                const actions = { insert: 'insert', query: 'query', aggregate: 'aggregate', latest: 'latest' };

                if (!domainFiles[domain]) domainFiles[domain] = [];
                if (!domainFiles[domain].includes(file)) domainFiles[domain].push(file);

                Object.entries(actions).forEach(([key, action]) => {
                    allContracts.push({
                        exportName: `${exportName}.${key}`,
                        domain,
                        action,
                        description: `Time Series ${key} for ${domain} (${exportName})`,
                        method: 'POST',
                        path: `/${domain}/${action}`,
                        isStream: false,
                        filePath: file,
                        // A generated CRUD/time-series action has no handler module: DatabaseMiddleware
                        // intercepts it before dispatch. loadDomain knows this from isCrud.
                        handlerPath: ''
                    });
                });
            }

            // 4. defineEvent Parser
            const eventMatches = content.matchAll(/export\s+const\s+(\w+)\s*=\s*defineEvent\s*\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)/g);
            for (const match of eventMatches) {
                const exportName = match[1]!;
                const eventName = match[2]!;

                // Add to a generic fallback key to ensure a reliable file-to-alias mapping structure
                if (!domainFiles['__events_fallback__']) domainFiles['__events_fallback__'] = [];
                if (!domainFiles['__events_fallback__'].includes(file)) domainFiles['__events_fallback__'].push(file);

                allEvents.push({
                    exportName,
                    name: eventName,
                    filePath: file
                });
            }
        }
        return { discovery: allContracts, events: allEvents, cruds: allCruds, files: domainFiles };
    }

    private walkDir(dir: string): string[] {
        let results: string[] = [];
        const list = fs.readdirSync(dir);
        list.forEach((file) => {
            const filePath = path.join(dir, file);
            const stat = fs.statSync(filePath);
            if (stat && stat.isDirectory()) {
                if (file === 'node_modules' || file === '.git' || file === 'dist' || file === '__tests__') return;
                results = results.concat(this.walkDir(filePath));
            } else {
                results.push(filePath);
            }
        });
        return results;
    }

    private getAliasMap(files: Record<string, string[]>, targetDir: string): Record<string, { alias: string, path: string }> {
        const allFiles = Array.from(new Set(Object.values(files).flat()));
        const map: Record<string, { alias: string, path: string }> = {};

        allFiles.forEach((file, idx) => {
            let importPath = path.relative(targetDir, file).replace(/\\/g, '/').replace(/\.ts$/, '.js');
            if (!importPath.startsWith('.')) {
                importPath = './' + importPath;
            }
            map[file] = {
                alias: `Contract_${idx}`,
                path: importPath
            };
        });
        return map;
    }
}