/**
 * A `register(broker)` part with a `long-running` contract, standing in for proxy.listen /
 * dns.listen: mounting it calls nothing, and the "listener" only exists once `onStartProbe.listen`
 * runs. `ctx.signal` is its stop -- exactly how the real ones close their sockets -- so a test can
 * tell a listener that was torn down from one that was left behind.
 */
import { defineContract, z } from '@flybyme/mesh';
import type { IServiceBroker, IServiceContext } from '@flybyme/mesh';

/** Every listener currently "open", by the port it was asked to bind. */
export const openListeners = new Set<number>();

export const listenContract = defineContract({
    domain: 'onStartProbe',
    action: 'listen',
    description: 'Open a listener on a port until stopped.',
    inputSchema: z.object({ port: z.number(), fail: z.boolean().optional() }),
    outputSchema: z.object({ port: z.number() }),
    rest: { method: 'POST', path: '/on-start-probe/listen' },
    filePath: 'test/fixtures/on-start/listener.ts',
    concurrency: 'long-running',
    permissions: [],
    print: (o) => `listening on ${String(o.port)}`,
});

export async function listen(input: { port: number; fail?: boolean }, ctx: IServiceContext): Promise<{ port: number }> {
    if (input.fail === true) throw new Error(`port ${String(input.port)} is in use`);
    openListeners.add(input.port);
    ctx.signal.addEventListener('abort', () => openListeners.delete(input.port));
    return { port: input.port };
}

export async function register(broker: IServiceBroker): Promise<string> {
    broker.registerContract(listenContract, listen);
    return 'onStartProbe';
}

export default register;
