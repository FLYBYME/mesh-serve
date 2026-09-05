/**
 * A dev page for one part, built from its own repository.
 *
 * The local loop a part author has not had: bundle the kernel out of `node_modules`, bundle this
 * part with the framework `external`, write an import map that resolves it to the one kernel, and
 * open it. No cdn, no catalog, no site record, no cluster.
 *
 * ## It boots the same way a real site does
 *
 * The boot module here was fifty lines of hand-written framework wiring until mesh-web 0.4.0, and it
 * is three lines and a call now — the same shape the cdn generates for a hostname. That matters more
 * than the line count: **a part that works here works there**, because there is one way to boot a
 * composition rather than a development one and a production one that drift.
 *
 * What stays different is only what a local page cannot have: no site record, so no theme values and
 * no SEO; the styles below are a minimum so windows are visible rather than a theme.
 *
 * Everything it writes goes in `.dev/`, which is disposable and gitignored. Nothing here is an
 * artifact, nothing is content-addressed, and none of it is what a deployment serves.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import { build as esbuild } from 'esbuild';

import { FRAMEWORK } from '../builder/methods/bundle.js';
import type { Descriptor } from '../builder/schema/descriptor.js';

export const DEV_DIR = '.dev';

export interface DevPageResult {
    readonly dir: string;
    readonly files: readonly string[];
    readonly warnings: readonly string[];
}

/**
 * Bundle the kernel and every part this repository declares, and write a page that loads them.
 *
 * @param root the part repository
 */
export async function writeDevPage(root: string, descriptor: Descriptor): Promise<DevPageResult> {
    const out = join(root, DEV_DIR);
    mkdirSync(out, { recursive: true });

    const warnings: string[] = [];
    const files: string[] = [];

    // Resolved from the part's own `node_modules`, so the dev page runs the exact framework the
    // editor typechecked against. A version mismatch between the two is the failure this removes.
    const require = createRequire(join(root, 'package.json'));
    let kernelEntry: string;
    try {
        kernelEntry = require.resolve(FRAMEWORK);
    } catch {
        throw new Error(
            `${FRAMEWORK} is not installed here, so there is no kernel to bundle. ` +
            `It is a devDependency for exactly this and for typechecking.`,
        );
    }

    await esbuild({
        entryPoints: [kernelEntry],
        bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
        outfile: join(out, 'kernel.js'), logLevel: 'silent',
    });
    files.push(`${DEV_DIR}/kernel.js`);

    for (const part of descriptor.parts) {
        await esbuild({
            entryPoints: [join(root, part.entry)],
            bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
            // The same rule the real builder follows, and the reason this page is worth having: a
            // part that accidentally works only because the framework was inlined into it fails
            // here, in the author's browser, instead of after it is published.
            external: [FRAMEWORK],
            outfile: join(out, `${part.id}.js`), logLevel: 'silent',
        });
        files.push(`${DEV_DIR}/${part.id}.js`);
    }

    const extensions = descriptor.parts.filter((p) => p.kind === 'extension');
    const applications = descriptor.parts.filter((p) => p.kind === 'application');

    if (applications.length === 0) {
        // An Extension contributes to a page; it does not open windows. A repository of nothing but
        // extensions renders an empty desktop, which is correct and looks broken.
        warnings.push(
            'No application in this repository, so the page will render an empty desktop. ' +
            'That is the right result and not a useful one.',
        );
    }

    write(join(out, 'boot.js'), bootModule(extensions, applications), files);
    write(join(out, 'index.html'), indexHtml(descriptor), files);

    return { dir: out, files, warnings };
}

function write(path: string, content: string, files: string[]): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    files.push(path);
}

function indexHtml(descriptor: Descriptor): string {
    const title = descriptor.parts[0]?.id ?? 'part';

    return `<!doctype html>
<html lang="en" data-api="${process.env['MESH_API'] ?? 'http://127.0.0.1:5005'}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} — dev</title>

    <!-- One kernel, one URL. Two would be two module graphs and two of every singleton the
         capability model depends on, which is the failure this page exists to catch early. -->
    <script type="importmap">
    { "imports": { "${FRAMEWORK}": "./kernel.js" } }
    </script>

    <style>
        :root { --surface: #161b22; --ink: #e6edf3; color-scheme: dark }
        html, body { margin: 0; height: 100%; background: #0d1117; color: var(--ink);
            font: 14px/1.5 ui-sans-serif, system-ui, sans-serif }
        #root { position: relative; height: 100% }
        .window { position: absolute; background: var(--surface); color: var(--ink);
            border: 1px solid #30363d; border-radius: 6px; overflow: hidden }
        .titlebar { padding: 6px 10px; background: #21262d; cursor: move; user-select: none }
    </style>
</head>
<body>
    <div id="root"></div>
    <script type="module" src="./boot.js"></script>
</body>
</html>
`;
}

/**
 * Imports, and one call.
 *
 * **This file used to be fifty lines**, doing by hand what the kernel did not yet own: a
 * `WindowManager`, a settings registry, `windowSink`, a component registry, `mountPage`, a command
 * dispatcher, a resize listener. It was written that way deliberately, as *the smallest honest
 * statement of what the kernel still owed* — and mesh-web 0.4.0's `start()` paid it, so it collapsed
 * to this, which is what the roadmap said it would.
 *
 * It is now the same shape the cdn generates for a real site. That is the point: a part that works
 * here works there, because the two boot the same way.
 */
function bootModule(
    extensions: readonly { id: string }[],
    applications: readonly { id: string }[],
): string {
    const all = [...extensions, ...applications];
    const imports = all
        .map((part, index) => `import part${String(index)} from './${part.id}.js';`)
        .join('\n');

    const parts = all
        .map((part, index) => `        { id: '${part.id}', contribution: part${String(index)} },`)
        .join('\n');

    // Named explicitly rather than left to the kernel's default: a part's default export is often a
    // constructor — anything taking site options has to be — and a class cannot be classified
    // without being built, which happens once, inside `boot`.
    const open = applications
        .map((app) => `        { application: '${app.id}' },`)
        .join('\n');

    return `// Generated by \`mesh-serve dev\`. Disposable — rewritten on every run.
import { start } from '${FRAMEWORK}';
${imports}

start({
    application: 'dev',
    api: document.documentElement.dataset.api ?? '',
    // The order here is not the order they start: the kernel resolves that from what each part
    // provides and consumes.
    parts: [
${parts}
    ],${open === '' ? '' : `
    open: [
${open}
    ],`}
});
`;
}

/**
 * A static server for `.dev/`.
 *
 * Thirty lines rather than a dependency, and deliberately dumb: no caching, no compression, no
 * range requests. It serves one directory to one developer.
 */
export async function serveDev(dir: string, port: number): Promise<string> {
    const { createServer } = await import('node:http');
    const { readFile } = await import('node:fs/promises');
    const { extname } = await import('node:path');

    const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.map': 'application/json; charset=utf-8',
    };

    const server = createServer((req, res) => {
        const path = (req.url ?? '/').split('?')[0] ?? '/';
        const file = resolve(dir, `.${path === '/' ? '/index.html' : path}`);

        // The one check worth having: a dev server is still a server, and `..` reaches the rest of
        // the disk.
        if (!file.startsWith(resolve(dir))) {
            res.writeHead(403).end('No');
            return;
        }

        void readFile(file)
            .then((body) => {
                res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
                res.end(body);
            })
            .catch(() => { res.writeHead(404).end('Not found'); });
    });

    await new Promise<void>((done) => { server.listen(port, '127.0.0.1', done); });
    return `http://127.0.0.1:${String(port)}/`;
}
