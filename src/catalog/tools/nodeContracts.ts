import type { IServiceContext, z } from '@flybyme/mesh';
import type { nodeContractsOutputSchema } from '../contracts/node.contract.js';

type Output = z.infer<typeof nodeContractsOutputSchema>;

/**
 * Every contract any node advertises, each described as the gateway sees it (contractDeclaration:
 * the nodes that run it say what it is), with the nodes that serve it.
 */
export async function contracts(_input: Record<string, never>, ctx: IServiceContext): Promise<Output> {
    const servedBy = new Map<string, string[]>();
    for (const node of ctx.broker.registry.getNodes()) {
        for (const key of new Set(node.services.flatMap((s) => Object.keys(s.tools ?? {})))) {
            servedBy.set(key, [...(servedBy.get(key) ?? []), node.nodeID]);
        }
    }

    const rows: Output = [];
    for (const [contract, nodes] of servedBy) {
        const declared = ctx.broker.contractDeclaration(contract);
        if (declared === undefined) continue;

        rows.push({
            contract,
            visibility: declared.visibility,
            permissions: [...declared.permissions],
            destructive: declared.destructive,
            method: declared.rest.method,
            path: declared.rest.path,
            nodes: nodes.sort(),
        });
    }

    return rows.sort((a, b) => a.contract.localeCompare(b.contract));
}
