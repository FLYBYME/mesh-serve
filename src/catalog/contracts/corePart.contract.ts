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
    domain: 'serve.corePart', action: 'load',
    description: 'Load one of mesh-serve\'s own precompiled core services onto this node.',
    inputSchema: corePartLoadInputSchema,
    outputSchema: corePartLoadOutputSchema,
    rest: { method: 'POST', path: '/core-parts/load' },
    destructive: true,
    filePath: 'src/catalog/tools/loadCorePart.ts', concurrency: 'on-demand', permissions: ['operator'],
    print: (o) => `${o.domain} loaded on ${o.nodeID}`,
});

export type CorePartLoadInput = z.infer<typeof corePartLoadContract.inputSchema>;
export type CorePartLoadOutput = z.infer<typeof corePartLoadContract.outputSchema>;
