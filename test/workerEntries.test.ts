import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runEsbuild, workerEntries } from '../src/catalog/methods/build.js';

// A browser part with a web worker and a stylesheet that loads a font, as an editor's are: the worker
// is built beside the part's own file, and the font is a file of the build.

const dirs: string[] = [];

async function part(files: Readonly<Record<string, string>>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-worker-entries-'));

    dirs.push(dir);

    for (const [name, content] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
        await fs.writeFile(path.join(dir, name), content);
    }

    return dir;
}

async function filesIn(dir: string, base = dir): Promise<string[]> {
    const found: string[] = [];

    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) found.push(...await filesIn(full, base));
        else found.push(path.relative(base, full).split(path.sep).join('/'));
    }

    return found.sort();
}

afterEach(async () => {
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('a browser part\'s workers and fonts', () => {
    it('builds each file of workers/ beside the part, and a font as a file', async () => {
        const dir = await part({
            'src/index.ts': "import './look.css';\nexport const worker = () => new Worker(new URL('./workers/count.js', import.meta.url), { type: 'module' });\n",
            'src/look.css': "@font-face { font-family: icons; src: url('./icons.ttf'); }\n",
            'src/icons.ttf': 'not really a font',
            'src/workers/count.ts': 'self.onmessage = (event: MessageEvent<number>) => self.postMessage(event.data + 1);\n',
            'src/workers/types.d.ts': 'export {};\n',
        });
        const entry = path.join(dir, 'src', 'index.ts');
        const workers = await workerEntries(entry);

        expect(workers.map((file) => path.basename(file))).toEqual(['count.ts']);

        const out = path.join(dir, 'out');

        await runEsbuild([entry, ...workers], out, []);

        const files = await filesIn(out);

        expect(files).toContain('index.js');
        expect(files).toContain('index.css');
        expect(files).toContain('workers/count.js');
        expect(files.some((file) => /^icons-[A-Z0-9]+\.ttf$/.test(file))).toBe(true);
    });

    it('leaves a part with no workers/ as it was: one entry', async () => {
        const dir = await part({ 'src/index.ts': 'export const one = 1;\n' });

        expect(await workerEntries(path.join(dir, 'src', 'index.ts'))).toEqual([]);
    });
});
