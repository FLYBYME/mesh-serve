import type { IServiceContext, z } from '@flybyme/mesh';
import type { nodeServingOutputSchema } from '../contracts/node.contract.js';

type Output = z.infer<typeof nodeServingOutputSchema>;

/** Every node this one knows that advertises `tool`, with the hash it advertises and its release. */
export async function serving(input: { tool: string }, ctx: IServiceContext): Promise<Output> {
    const servers = ctx.broker.registry.getNodes().flatMap((node) => {
        const advertised = node.services.map((s) => s.tools?.[input.tool]).find((t) => t !== undefined);
        if (advertised === undefined) return [];

        return [{
            nodeID: node.nodeID,
            available: node.available !== false,
            ...(advertised.hash !== undefined ? { hash: advertised.hash } : {}),
            ...(node.software?.['mesh-serve'] !== undefined ? { meshServe: node.software['mesh-serve'] } : {}),
            ...(node.software?.mesh !== undefined ? { mesh: node.software.mesh } : {}),
        }];
    }).sort((a, b) => a.nodeID.localeCompare(b.nodeID));

    const first = servers[0];
    const agree = servers.every((s) => s.hash === first?.hash && s.meshServe === first?.meshServe);

    return { tool: input.tool, servers, agree };
}
