import type { IServiceContext, IServiceBroker } from '@flybyme/mesh';

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

    const broker = {
        call: callFn,
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
