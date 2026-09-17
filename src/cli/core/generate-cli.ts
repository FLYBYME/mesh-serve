#!/usr/bin/env node
import { GenerateCommand } from './GenerateCommand.js';

const args: { dir?: string; out?: string; include?: string[] } = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') args.dir = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--include' || argv[i] === '-I') {
        // Variadic, matching GenerateCommand's own Commander definition (`-I, --include <paths...>`):
        // every following token up to the next `--flag` is a package name or path, not just one.
        args.include ??= [];
        while (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) {
            args.include.push(argv[++i]!);
        }
    }
}

new GenerateCommand().execute(args).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
});
