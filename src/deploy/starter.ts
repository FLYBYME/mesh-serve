/**
 * What `mesh-serve init` writes into an empty repository: the smallest mesh-web app that typechecks
 * and deploys -- a package.json pinned to mesh-web's and mesh-web-kit's newest tags, the tsconfig
 * every site uses, an App with one page, and the typed client of the api it calls. Built on the app
 * model (mesh-web docs/app-model.md) and the kit's pieces; no JSX, no raw DOM.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const MESH_WEB_URL = 'https://github.com/FLYBYME/mesh-web';
export const MESH_WEB_KIT_URL = 'https://github.com/FLYBYME/mesh-web-kit';

/** The highest vX.Y.Z tag on a remote; `fallback` when it cannot be asked. */
export async function newestTag(url: string, fallback: string): Promise<string> {
    const { stdout } = await run('git', ['ls-remote', '--tags', '--refs', url]).catch(() => ({ stdout: '' }));
    const versions = stdout.split('\n')
        .map((line) => /refs\/tags\/v(\d+)\.(\d+)\.(\d+)$/.exec(line.trim()))
        .flatMap((m) => (m === null ? [] : [[Number(m[1]), Number(m[2]), Number(m[3])]]));

    versions.sort((a, b) => (b[0] ?? 0) - (a[0] ?? 0) || (b[1] ?? 0) - (a[1] ?? 0) || (b[2] ?? 0) - (a[2] ?? 0));
    const top = versions[0];

    return top === undefined ? fallback : `v${top.join('.')}`;
}

export interface StarterInput {
    readonly name: string;
    readonly title: string;
    readonly apiHost: string;
    /** What the generated client exports its api as (generateClient's apiExportName). */
    readonly apiExport: string;
    readonly meshWebTag: string;
    readonly kitTag: string;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 4)}\n`;

/** Every file of the starter, by its path in the repository. */
export function starterFiles(input: StarterInput): ReadonlyMap<string, string> {
    const files = new Map<string, string>();

    files.set('package.json', json({
        name: input.name,
        version: '0.1.0',
        type: 'module',
        private: true,
        scripts: { typecheck: 'tsc -p tsconfig.json --noEmit' },
        dependencies: {
            '@flybyme/mesh-web-kit': `github:FLYBYME/mesh-web-kit#${input.kitTag}`,
            zod: '^3.25.76',
        },
        devDependencies: {
            '@flybyme/mesh-web': `github:FLYBYME/mesh-web#${input.meshWebTag}`,
            typescript: '^5.9.3',
        },
    }));

    files.set('tsconfig.json', json({
        compilerOptions: {
            target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', lib: ['ES2022', 'DOM', 'DOM.Iterable'],
            // Browser code: a node builtin here is a compile error, not a page that fails.
            types: [],
            strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, noImplicitOverride: true,
            noFallthroughCasesInSwitch: true, noEmit: true, skipLibCheck: true, verbatimModuleSyntax: true, isolatedModules: true,
        },
        include: ['src/**/*.ts'],
    }));

    files.set('.gitignore', 'node_modules/\ndist/\n*.tsbuildinfo\n\n# mesh-serve deploy\'s record of what it deployed and what it replaced: the way back.\n.deploys.jsonl\n');

    files.set('src/index.ts', `/**
 * ${input.title}: the map of the site -- every URL and the page it shows. mesh-serve's boot script
 * hands this default export to the kernel's start().
 */

import '@flybyme/mesh-web-kit/kit.css';
import { App, needs } from '@flybyme/mesh-web';
import { ${input.apiExport} } from './generated/api.js';
import { HomeView } from './home-view.js';

export default class Site extends App({
    needs: needs('mesh'),
    api: ${input.apiExport},
    routes: {
        '/': HomeView,
    },
}) {}
`);

    files.set('src/home-view.ts', `import { element, text, View, type Node } from '@flybyme/mesh-web';
import { pageHeader, panel } from '@flybyme/mesh-web-kit';

/** The first page. Pages read and write through services (mesh-web docs/app-model.md). */
export class HomeView extends View({ title: ${JSON.stringify(input.title)} }) {
    render(): Node {
        return element('Stack', {
            children: [
                pageHeader(${JSON.stringify(input.title)}),
                panel('Start here', element('Text', {
                    children: [text('This page is src/home-view.ts; the routes are in src/index.ts. It calls ${input.apiHost}, through src/generated/api.ts.')],
                })),
            ],
        });
    }
}
`);

    return files;
}

/** Writes each starter file that is not there yet; returns the ones it wrote. */
export async function writeStarter(dir: string, files: ReadonlyMap<string, string>): Promise<string[]> {
    const written: string[] = [];

    for (const [file, content] of files) {
        const target = path.join(dir, file);
        const there = await fs.stat(target).then(() => true, () => false);
        if (there) continue;

        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
        written.push(file);
    }

    return written;
}
