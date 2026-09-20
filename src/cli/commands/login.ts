import readline from 'node:readline';
import type { Command as CommanderCommand } from 'commander';
import { z } from '@flybyme/mesh';

import { BaseCommand } from '../core/BaseCommand.js';
import { ZodToCliMapper } from '../core/ZodToCliMapper.js';
import { question, questionHidden } from '../prompt.js';
import { ApiError, callApi, describeApi } from '../core/apiClient.js';
import { patchSession, readSession, sessionPath } from '../core/session.js';

/** Same reasoning as bootstrap's MESH_BOOTSTRAP_PASSWORD: a secret belongs in the environment. */
const PASSWORD_ENV = 'MESH_PASSWORD';

const loginInputSchema = z.object({
    api: z.string().optional().describe('The api to log in against, e.g. http://api.localhost:3223 -- defaults to the one already switched to'),
    email: z.string().optional().describe('The account signing in; prompted for if omitted'),
});

/**
 * Exchanges an email and password for a ticket, and keeps it.
 *
 * One login, every api. A ticket carries no api and no tenant, so the stored token works against
 * whichever gate `switch` later points at -- see `core/session.ts`. This is the first command in
 * the post-bootstrap world: `bootstrap` is the last thing that touches the mesh directly, and
 * everything after it is an ordinary api client that has to authenticate like any other.
 *
 * The password is never accepted as a flag. A CLI option lands in shell history and in the process
 * table of every other user on the machine; there is no version of that which is worth the
 * convenience. `MESH_PASSWORD` does neither, and is how CI and deploy tooling already expect to
 * pass a secret -- so that, with `--email`, is the unattended path. `--email` alone is fine
 * interactively: it is not a secret, and it leaves only one prompt.
 */
export class LoginCommand extends BaseCommand {
    public readonly name = 'login';
    public readonly description = 'Sign in to an api and keep the ticket for later commands';

    public register(program: CommanderCommand): void {
        const sub = program.command(this.name).description(this.description);
        ZodToCliMapper.applyOptions(sub, loginInputSchema);
        sub.action(async (opts: Record<string, unknown>) => {
            await this.execute(ZodToCliMapper.parseOptions(opts, loginInputSchema));
        });
    }

    protected async execute(args: z.infer<typeof loginInputSchema>): Promise<void> {
        const session = await readSession();
        const apiUrl = args.api ?? session.apiUrl;

        if (apiUrl === undefined) {
            this.logger.error('No api to log in against. Pass --api http://api.localhost:3223, or run `mesh-serve switch <url>` first.');
            process.exitCode = 1;
            return;
        }

        // Before asking for a password: prove something is listening and that it exposes a login at
        // all. `_describe` is public, so this costs nothing and turns "wrong port" into a clear
        // message instead of a failed credential.
        const descriptor = await describeApi(apiUrl);
        const issue = descriptor.calls.find((call) => call.key === 'identity.ticket.issue');
        if (issue === undefined) {
            this.logger.error(`"${descriptor.host}" does not expose identity.ticket.issue, so there is no way to log in against it.`);
            this.logger.error('That api may be an application gate rather than a management one -- try the api bootstrap created.');
            process.exitCode = 1;
            return;
        }

        const fromEnv = process.env[PASSWORD_ENV];
        let email: string;
        let password: string;

        if (args.email !== undefined && fromEnv !== undefined) {
            email = args.email;
            password = fromEnv;
        } else if (process.stdin.isTTY !== true) {
            this.logger.error(`Not a terminal. Pass --email and ${PASSWORD_ENV} to sign in without prompts.`);
            process.exitCode = 1;
            return;
        } else {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            try {
                email = args.email ?? (await question(rl, 'Email: '));
                password = fromEnv ?? (await questionHidden(rl, 'Password: '));
            } finally {
                rl.close();
            }
        }

        let issued: { token: string; userId: string; expiresAt: number };
        try {
            issued = await callApi(apiUrl, issue, { email, password, via: 'cli' }) as typeof issued;
        } catch (err) {
            if (err instanceof ApiError && err.status === 401) {
                this.logger.error('Those credentials were rejected.');
                process.exitCode = 1;
                return;
            }
            throw err;
        }

        await patchSession({
            apiUrl,
            token: issued.token,
            userId: issued.userId,
            email,
            expiresAt: issued.expiresAt,
            descriptor: {
                host: descriptor.host,
                base: descriptor.base,
                shapeHash: descriptor.shapeHash,
                exposure: descriptor.exposure,
                calls: descriptor.calls,
                fetchedAt: Date.now(),
            },
        });

        const expires = new Date(issued.expiresAt).toLocaleString();
        this.logger.info(`Signed in to ${descriptor.host} as ${email}. Ticket expires ${expires}.`);
        this.logger.info(`${String(descriptor.calls.length)} call(s) available. Stored in ${sessionPath()}.`);
    }
}
