#!/usr/bin/env node
/**
 * The mesh-serve CLI.
 *
 * `spec/cli.md`. Two things live here: `node`, which runs a node, and everything else, which is a
 * client of a site's API. There is no third path — no database handle, no joining the mesh to
 * assert an identity.
 */

const [command, ...rest] = process.argv.slice(2);

/**
 * **`node` belongs here rather than in `package.json`.**
 *
 * It was an npm script wrapping `bin/node.mjs`, which meant the most important command on the
 * platform was reachable only from a checkout of this repository.
 */
if (command === 'node') {
    // Argv is rewritten because node.mjs reads `process.argv` directly, and it should keep doing so:
    // it is a program that happens to be reachable from here, not a function this file calls.
    process.argv = [process.argv[0], process.argv[1], ...rest];
    await import('./node.mjs');
    // No exit — the node runs until it is stopped, and nothing after this may run.
} else {
    const { run } = await import('../dist/cli/run.js');
    process.exitCode = await run(process.argv.slice(2));
}
