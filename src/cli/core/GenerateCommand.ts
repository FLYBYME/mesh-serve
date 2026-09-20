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