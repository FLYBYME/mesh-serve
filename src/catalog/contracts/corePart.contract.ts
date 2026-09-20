import { defineContract, z } from '@flybyme/mesh';

/**
 * mesh-serve's own five non-kernel services -- not catalog-managed parts (no `serve.part`/
 * `serve.repo`/`serve.artifact` row exists for any of them), precompiled at build time into
 * `dist/parts/*.cjs` (`cli/core/buildCoreParts.ts`) and shipped inside this package. `serve.catalog`
 * itself is the one service `start` still mounts statically -- it alone owns this contract, the
 * mechanism that loads everything else, including these five.
 */
export const CORE_PART_NAMES = ['identity', 'cdn', 'hold', 'queue', 'api'] as const;
export type CorePartName = typeof CORE_PART_NAMES[number];

export const corePartLoadInputSchema = z.object({
    name: z.enum(CORE_PART_NAMES).describe('Which of mesh-serve\'s own precompiled core services to load onto this node'),
});

export const corePartLoadOutputSchema = z.object({
    domain: z.string().describe('The mount key the service registered under on this node'),
    nodeID: z.string().describe('This node\'s own id'),
});

/**
 * Loads one of mesh-serve's own core services onto whichever node this call actually reaches --
 * `bootstrap` is the intended (and, on a fresh cluster, only realistic) caller: a plain `start`
 * mounts only the catalog kernel, so nothing else exists to claim an operator against until
 * something calls this. Internal only (no `visibility: 'public'`) -- there is no reason an ordinary
 * api caller would ever need this; it is the platform's own bootstrap moment, not a feature to
 * expose.
 */
export const corePartLoadContract = defineContract({
    domain: 'serve.corePart',
    action: 'load',
    description: 'Load one of mesh-serve\'s own precompiled core services onto this node.',
    inputSchema: corePartLoadInputSchema,
    outputSchema: corePartLoadOutputSchema,
    rest: { method: 'POST', path: '/core-parts/load' },
    destructive: true,
    filePath: 'src/catalog/tools/loadCorePart.ts',
    concurrency: 'on-demand',
    permissions: ['operator'],
    print: (o) => `${o.domain} loaded on ${o.nodeID}`,
});

export type CorePartLoadInput = z.infer<typeof corePartLoadContract.inputSchema>;
export type CorePartLoadOutput = z.infer<typeof corePartLoadContract.outputSchema>;

export const corePartUnloadInputSchema = z.object({
    name: z.enum(CORE_PART_NAMES).describe('Which core service to unload from this node'),
});

export const corePartUnloadOutputSchema = z.object({
    domains: z.array(z.string()).describe('The domains this part had mounted here'),
    contracts: z.number().describe('How many contracts were unmounted'),
    evicted: z.boolean().describe('Whether the module itself was dropped, so the next load re-reads it from disk'),
    nodeID: z.string(),
});

/**
 * The other half of `load`: unmount the part and drop its module.
 *
 * Unmounting is what actually stops a `long-running` or `interval` contract, because
 * `unregisterContract` aborts the registration-scoped `ctx.signal` a listener hung its `close()`
 * on and clears an interval's timer. Eviction is what makes the *next* load real rather than a
 * no-op returning the already-evaluated module -- which is why core parts are built as CommonJS
 * and loaded with `require()` at all: an ES module cannot be dropped once evaluated.
 *
 * Internal only, like `load`.
 */
export const corePartUnloadContract = defineContract({
    domain: 'serve.corePart',
    action: 'unload',
    description: 'Unmount one of mesh-serve\'s own core services from this node and drop its module.',
    inputSchema: corePartUnloadInputSchema,
    outputSchema: corePartUnloadOutputSchema,
    rest: { method: 'POST', path: '/core-parts/unload' },
    destructive: true,
    filePath: 'src/catalog/tools/unloadCorePart.ts',
    concurrency: 'on-demand',
    permissions: ['operator'],
    print: (o) => `${o.domains.join(', ')} unloaded from ${o.nodeID}${o.evicted ? ' (module evicted)' : ''}`,
});

export type CorePartUnloadInput = z.infer<typeof corePartUnloadContract.inputSchema>;
export type CorePartUnloadOutput = z.infer<typeof corePartUnloadContract.outputSchema>;
