import type { IServiceBroker } from '@flybyme/mesh';

import { partInStack, partOfOwner, type RunningPart } from './services.js';

/**
 * One part's uncaught exception costs that part, not its node.
 *
 * Node ends the process on an uncaught exception (or an unhandled rejection), and every part a node
 * runs lives in that process: 11-05, a library bug in one part (an SSH server's cleanup on a
 * scanner's dropped connection) ended a node, and the nameserver beside it went with it until the
 * process came back. Here the stack decides: when it runs through a catalog part's own build
 * (`partInStack`) -- or, with no frame of the part's, when the work that threw was the part's (the
 * broker's owner in effect, `partOfOwner`) -- that part is stopped on this node -- unmounted and its module dropped, as
 * `serve.part.stop` always does -- and the supervisor's next pass starts it again, since it is still
 * desired. Everything else on the node carries on.
 *
 * When no part is named -- mesh-serve's own code, or a library called from nothing a part owns --
 * nothing is known safe to drop, so the process ends as it would have: the error, then exit 1. The
 * same when stopping the named part fails.
 *
 * A part is code the operator trusts (mesh runs only known code): this keeps a fault in one from
 * becoming an outage of all, it does not contain a hostile one. What the part held when it threw
 * (half-written state of its own) goes with its module.
 */

export interface FaultLogger {
    error(message: string): void;
    info(message: string): void;
}

export interface FaultIsolationOptions {
    readonly broker: Pick<IServiceBroker, 'callNamed' | 'ownerInEffect'>;
    readonly nodeID: string;
    readonly logger: FaultLogger;
    /** How the process ends when nothing can be isolated: process.exit, swapped in tests. */
    readonly exit?: (code: number) => void;
}

/** What the handler did with one fault. */
export type FaultOutcome =
    | { readonly kind: 'stopping'; readonly part: RunningPart }
    | { readonly kind: 'already-stopping'; readonly part: RunningPart }
    | { readonly kind: 'exit' };

function stackOf(err: unknown): string {
    if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;

    return String(err);
}

/**
 * The handler itself, apart from `process` so it can be driven directly. Returns at once: the stop
 * runs on, and its failure ends the process.
 */
export function createFaultHandler(options: FaultIsolationOptions): (err: unknown, origin: string) => FaultOutcome {
    const exit = options.exit ?? ((code: number): void => process.exit(code));
    const { logger, nodeID } = options;
    // A part already being stopped may throw again from what is still unwinding: one stop is enough.
    const stopping = new Set<string>();

    return (err, origin) => {
        const stack = stackOf(err);
        // The stack first; else whose work this was (the broker's owner in effect, which Node keeps
        // across timers and sockets into this handler): 11-05, node:net's EADDRINUSE out of the SSH
        // door's listen had no frame of the door's and ended ns2's node.
        const part = partInStack(nodeID, stack) ?? partOfOwner(nodeID, options.broker.ownerInEffect());

        if (part === undefined || part.tenantId === undefined) {
            logger.error(`Uncaught ${origin} on ${nodeID}, in no part that can be stopped alone; the node ends.\n${stack}`);
            exit(1);
            return { kind: 'exit' };
        }

        if (stopping.has(part.partId)) {
            logger.error(`Part ${part.partId} (${part.domain}) threw again while being stopped (${origin}).\n${stack}`);
            return { kind: 'already-stopping', part };
        }

        stopping.add(part.partId);
        logger.error(`Part ${part.partId} (${part.domain}) threw (uncaught ${origin}): stopping it on ${nodeID}; the node carries on, and the part is started again as it is still desired.\n${stack}`);

        const tenantId = part.tenantId;
        void options.broker.callNamed('serve.part.stop', { id: part.partId }, { nodeID, meta: { tenant_id: tenantId } })
            .then(() => {
                logger.info(`Part ${part.partId} (${part.domain}) stopped on ${nodeID} after its fault.`);
            }, (stopErr: unknown) => {
                logger.error(`Part ${part.partId} (${part.domain}) could not be stopped after its fault, so the node ends: ${stackOf(stopErr)}`);
                exit(1);
            })
            .finally(() => {
                stopping.delete(part.partId);
            });

        return { kind: 'stopping', part };
    };
}

/** Installs the handler for this process; returns its removal. */
export function installPartFaultIsolation(options: FaultIsolationOptions): () => void {
    const handle = createFaultHandler(options);
    const listener = (err: unknown, origin: string): void => {
        handle(err, origin);
    };
    process.on('uncaughtException', listener);

    return () => {
        process.off('uncaughtException', listener);
    };
}
