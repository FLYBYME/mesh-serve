import { restClient } from './client.js';
import { ensureDescriptor } from './ensureDescriptor.js';
import { buildProgram } from './commandTree.js';
import type { Session } from './session.js';

export async function runOneShot(session: Session, argv: readonly string[]): Promise<void> {
    const descriptor = await ensureDescriptor(session, restClient);

    const program = buildProgram(session, descriptor, restClient, (_call, result) => {
        console.log(JSON.stringify(result, null, 2));
    });

    await program.parseAsync(argv as string[], { from: 'user' });
}
