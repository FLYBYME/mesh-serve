import type { Command as CommanderCommand } from 'commander';

import { BaseCommand } from '../core/BaseCommand.js';
import { describeApi } from '../core/apiClient.js';
import { isLive, patchSession, readSession, sessionPath, toCachedDescriptor } from '../core/session.js';

/**
 * Points the CLI at an api, and re-reads what that api offers.
 *
 * Every api is a different surface. `api.localhost` is where sites, exposes and parts are managed;
 * `my-app-api.localhost` serves an application's own contracts and nothing else. That separation is
 * not a policy check -- routing is strictly per-api (`gateway.resolveTarget` loads only *that*
 * api's `serve.expose` rows), so a management call against an application gate is a 404, and after
 * switching, the command simply is not in `--help`. It is absent rather than forbidden.
 *
 * Switching never asks you to log in again: the ticket is a user credential with no api or tenant
 * bound to it. What changes is what you can say, and -- if the new api belongs to another
 * organization -- what your roles there permit (`identity.hasRole` is asked per organization).
 *
 * With no url, reports where the CLI currently points instead of moving it.
 */
export class SwitchCommand extends BaseCommand {
    public readonly name = 'switch';
    public readonly description = 'Point the CLI at an api (no url: show where it points now)';

    public register(program: CommanderCommand): void {
        program
            .command(this.name)
            .description(this.description)
            .argument('[url]', 'Origin of the api, e.g. http://api.localhost:3223')
            .action(async (url: string | undefined) => { await this.execute(url); });
    }

    protected async execute(url: string | undefined): Promise<void> {
        const session = await readSession();

        if (url === undefined) {
            if (session.apiUrl === undefined) {
                this.logger.info('Not pointed at any api. Run `mesh-serve switch <url>`.');
                return;
            }
            const who = session.email ?? session.userId ?? 'nobody';
            const live = isLive(session);
            this.logger.info(`${session.descriptor?.host ?? session.apiUrl} (${session.apiUrl})`);
            this.logger.info(`  signed in as: ${who}${session.token === undefined ? '' : live ? '' : ' -- ticket expired, run `mesh-serve login`'}`);
            if (session.descriptor !== undefined) {
                const age = Math.round((Date.now() - session.descriptor.fetchedAt) / 60000);
                this.logger.info(`  ${String(session.descriptor.calls.length)} call(s), read ${String(age)} minute(s) ago`);
            }
            this.logger.info(`  ${sessionPath()}`);
            return;
        }

        const descriptor = await describeApi(url);

        // The shape hash is what changed-ness means here: `_describe` computes it over every call's
        // key, method, path and schemas, so an unchanged hash means the cached commands are still
        // exactly right. Worth saying out loud, because it is the difference between "I switched
        // and nothing looks different" being reassuring or being a bug.
        const previous = session.descriptor;
        const unchanged = previous !== undefined && previous.shapeHash === descriptor.shapeHash;

        await patchSession({ apiUrl: url, descriptor: toCachedDescriptor(descriptor) });

        const gated = descriptor.calls.filter((call) => call.gate !== 'public').length;
        this.logger.info(`${descriptor.host}: ${String(descriptor.calls.length)} call(s), ${String(gated)} gated.`);

        if (unchanged) this.logger.info('Same surface as before -- nothing changed.');

        if (session.token === undefined) {
            this.logger.info('Not signed in. Run `mesh-serve login`.');
        } else if (!isLive(session)) {
            this.logger.info('Stored ticket has expired. Run `mesh-serve login`.');
        } else {
            // Deliberately not verified against the new api here: whether this account has roles in
            // *that* api's organization is a question its own gate answers per call, and asking it
            // now would mean either a spurious call or a claim that might be wrong by the next one.
            this.logger.info(`Still signed in as ${session.email ?? session.userId ?? 'the stored account'}.`);
        }
    }
}
