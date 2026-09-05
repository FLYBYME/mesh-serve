/**
 * A dev page for one part, built from its own repository.
 *
 * The local loop a part author has not had: bundle the kernel out of `node_modules`, bundle this
 * part with the framework `external`, write an import map that resolves it to the one kernel, and
 * open it. No cdn, no catalog, no site record, no cluster.
 *
 * ## Why this is not the cdn's page
 *
 * The cdn generates a **composition** and never framework code — a generator that tracks another
 * package's internals is a second copy of that package. That rule holds there and this is the
 * exception that proves what it costs: `start()` does not exist yet (mesh-web A9.1c), so the boot
 * code below has to do by hand what the kernel will do for itself. It is ~20 lines and it will
 * collapse to three the day `start` lands.
 *
 * Which makes this the forcing function rather than a workaround: **this file is the smallest honest
 * statement of what the kernel still owes.** Every line here that is not "load these parts" is a
 * line the kernel should have owned.
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
 * What the kernel will one day do for itself.
 *
 * Every line below that is not *"load these parts"* is a line mesh-web A9.1c moves into `start()`.
 * Read it as a bill, not as a design.
 */
function bootModule(
    extensions: readonly { id: string }[],
    applications: readonly { id: string }[],
): string {
    const all = [...extensions, ...applications];
    const imports = all
        .map((part, index) => `import part${String(index)} from './${part.id}.js';`)
        .join('\n');

    const contributions = all
        .map((part, index) => `    { id: '${part.id}', contribution: new part${String(index)}() },`)
        .join('\n');

    return `// Generated by \`mesh-serve dev\`. Disposable — rewritten on every run.
//
// This is the boot code the kernel does not yet own (mesh-web A9.1c). When start() lands, all of it
// below the imports becomes one call.
import {
    createRegistry, mountPage, windowSink, Kernel, PRIMITIVES, WindowManager,
} from '${FRAMEWORK}';
${imports}

const root = document.getElementById('root');
const manager = new WindowManager({ width: root.clientWidth, height: root.clientHeight });
const kernel = new Kernel();

kernel.services.windows = windowSink(manager, (owner, view) => kernel.viewOf(owner, view));

// The order here is not the order they start: the kernel resolves that from what each part
// provides and consumes.
kernel.boot([
${contributions}
]);

const components = createRegistry(PRIMITIVES);
const run = (action) => {
    if (action.kind === 'command') void kernel.services.commands.get(action.id)?.run(...(action.args ?? []));
};

mountPage(root, {
    manager,
    viewOf: (owner, view) => {
        const process = kernel.processes.find((p) => p.pid === owner);
        return process === undefined ? undefined : kernel.viewOf(process.pid, view);
    },
    apiOf: (owner) => kernel.processes.find((p) => p.pid === owner)?.api,
    render: { components, dispatch: { dispatch: run } },
    onCommand: run,
});

window.addEventListener('resize', () => {
    manager.setViewport({ width: root.clientWidth, height: root.clientHeight });
});

${applications.length === 0 ? '' : `// Open the applications, or the desktop is correctly empty and looks broken.
void (async () => {
${applications.map((app) => `    await kernel.start('${app.id}');`).join('\n')}
})();
`}`;
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
