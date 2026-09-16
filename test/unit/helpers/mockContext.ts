import type { IServiceContext, IServiceBroker } from '@flybyme/mesh';
import { Logger, LogLevel, ServiceBroker } from '@flybyme/mesh';

export interface MockContextOptions {
    meta?: Record<string, any>;
    handlers?: Record<string, (params: any, options?: any) => any | Promise<any>>;
}

export interface MockContextResult {
    ctx: IServiceContext;
    calls: { action: string; params: any; options?: any }[];
    emitted: { event: string; params: any; options?: any }[];
}

export function createMockContext(options: MockContextOptions = {}): MockContextResult {
    const calls: { action: string; params: any; options?: any }[] = [];
    const emitted: { event: string; params: any; options?: any }[] = [];

    const callFn = async (action: string, params: any, callOptions?: any) => {
        calls.push({ action, params, options: callOptions });
        const handler = options.handlers?.[action];
        if (handler) {
            return handler(params, callOptions);
        }
        return undefined;
    };

    const emitFn = (event: string, params: any, emitOptions?: any) => {
        emitted.push({ event, params, options: emitOptions });
    };

    // A mock has no real registry, so there's no "leader" to route to -- callOnLeader just calls
    // directly, same as `call`. acquire/release/withLock borrow a real ServiceBroker purely for
    // its lock implementation (pure in-memory, no network/registry needed to work), so code under
    // test that uses withLock gets real TTL/fencing-token semantics in a unit test too, not a stub
    // that silently no-ops and could hide a real locking bug.
    const lockBroker = new ServiceBroker('mock-node', new Logger(LogLevel.ERROR));

    const callOnLeaderFn = async (_domain: string, action: string, params: any, callOptions?: any) =>
        callFn(action, params, callOptions);

    const broker = {
        call: callFn,
        callOnLeader: callOnLeaderFn,
        acquire: (key: string, lockOptions?: any) => lockBroker.acquire(key, lockOptions),
        release: (key: string, token: string) => lockBroker.release(key, token),
        withLock: (key: string, fn: () => Promise<any>, lockOptions?: any) => lockBroker.withLock(key, fn, lockOptions),
        emit: emitFn,
        logger: {
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {},
        },
        nodeID: 'mock-node',
    } as unknown as IServiceBroker;

    const ctx: IServiceContext = {
        broker,
        nodeID: 'mock-node',
        correlationId: 'mock-correlation-id',
        meta: options.meta ?? {},
        call: callFn,
        callOnLeader: callOnLeaderFn,
        acquire: (key: string, lockOptions?: any) => lockBroker.acquire(key, lockOptions),
        release: (key: string, token: string) => lockBroker.release(key, token),
        withLock: (key: string, fn: () => Promise<any>, lockOptions?: any) => lockBroker.withLock(key, fn, lockOptions),
        emit: emitFn,
        logger: {
            debug: () => {},
            info: () => {},
            warn: () => {},
            error: () => {},
            child: () => ({} as any),
            getLevel: () => 'info',
        } as any,
    };

    return { ctx, calls, emitted };
}
