import type { ILogger } from '@flybyme/mesh';

/** What a stop signal tears down: a started MeshApp. */
export interface Stoppable {
    stop(): Promise<void>;
}

/**
 * A node stops when it is told to. Node is PID 1 in a mesh pod, and PID 1 gets no default action
 * for SIGTERM: a stop waited out the whole grace period (30 s) and was then killed mid-call
 * (found moving the database, 10-16). Now SIGTERM or SIGINT tears the node down and exits 0; if
 * the teardown fails, or has not finished within `deadlineMs`, it exits 1 anyway. A second signal
 * while stopping changes nothing.
 */
export function stopOnSignal(
    node: Stoppable,
    logger: Pick<ILogger, 'info' | 'warn' | 'error'>,
    deadlineMs = 20_000,
    exit: (code: number) => void = (code) => process.exit(code),
): void {
    let stopping = false;

    const onSignal = (signal: NodeJS.Signals): void => {
        if (stopping) {
            return;
        }
        stopping = true;
        logger.info(`${signal}: stopping this node.`);

        const giveUp = setTimeout(() => {
            logger.warn(`Not stopped within ${deadlineMs} ms: exiting anyway.`);
            exit(1);
        }, deadlineMs);
        giveUp.unref();

        node.stop().then(() => {
            clearTimeout(giveUp);
            exit(0);
        }, (err: unknown) => {
            clearTimeout(giveUp);
            logger.error(`Stopping failed: ${err instanceof Error ? err.message : String(err)}`);
            exit(1);
        });
    };

    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
}
