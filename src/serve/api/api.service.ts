/**
 * The `api` projection: HTTP.
 *
 * `spec/serving.md` §2 is the pipeline and this file is that pipeline, in order, once. **A
 * projection answers four questions and then gets out of the way** — which site, which account,
 * which organization, may this caller call this here.
 *
 * It decides nothing about what is callable. It reads the site's description and serves what HTTP
 * can express, which is all of it.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
    globalContractRegistry, ServiceModule, type IServiceBroker, type IServiceRegistry, type ToolContract, type z,
} from '@flybyme/mesh';

import { describeSite, describedCallSummary, type SiteDescription } from '../methods/descriptor.js';
import { errorResponse, refuse, type ErrorResponse } from '../methods/errors.js';
import { gate, SCOPE_HEADER, type Caller } from '../methods/gate.js';
import { hostOf } from '../methods/hostname.js';
import { decodeQuery, matchRoute, mergeInput, routeTable, type Route } from '../methods/routes.js';
import { gateOf, type Site } from '../schema/site.js';

export interface ApiServiceOptions {
    readonly port?: number;
    readonly host?: string;
    /**
     * Whether `x-forwarded-host` is authoritative.
     *
     * **A deployment decision, never a guess.** Behind a trusted proxy it must be; on a node
     * reachable directly it must not, or a caller names any hostname and is served whatever it
     * serves. Defaults to false, which is the safe direction.
     */
    readonly trustForwarded?: boolean;
    /** One megabyte. A body is refused at the limit, not buffered and then measured. */
    readonly maxBodyBytes?: number;
}

/** mesh's own domain, which no site may expose. The api is a projection, not a surface. */
const API_DOMAIN = 'api';

export class ApiService extends ServiceModule {
    public readonly domain = API_DOMAIN;

    private readonly port: number;
    private readonly bindHost: string;
    private readonly trustForwarded: boolean;
    private readonly maxBodyBytes: number;

    private server: Server | undefined;
    private broker: IServiceBroker | undefined;

    /**
     * Route tables, keyed by the site's shape hash.
     *
     * **Keyed by the hash rather than by the hostname**, so editing a site's exposure invalidates it
     * by construction. A cache keyed by hostname is one that serves yesterday's surface until
     * somebody restarts the process, and that is a security bug rather than a staleness bug.
     */
    private readonly tables = new Map<string, readonly Route[]>();

    constructor(options: ApiServiceOptions = {}) {
        super();

        this.port = options.port ?? Number(process.env['API_PORT'] ?? 5005);
        this.bindHost = options.host ?? '0.0.0.0';
        this.trustForwarded = options.trustForwarded ?? false;
        this.maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
    }

    public async onStart(broker: IServiceBroker): Promise<void> {
        this.broker = broker;

        const server = createServer((request, response) => {
            this.handle(request, response).catch((error: unknown) => {
                // The last resort. Everything below already turns a failure into a response, so
                // reaching here means the responder itself threw.
                send(response, errorResponse(error, logUnmapped));
            });
        });

        /**
         * **A port already in use is an operator's problem with an obvious fix, so it gets a
         * sentence rather than a stack.**
         *
         * Without this the node printed the first-boot banner — the password that is shown once and
         * is not recoverable — and *then* died on an unhandled `EADDRINUSE` from deep inside `net`.
         * Somebody is left holding a credential, looking at a stack trace, on a cluster that is not
         * running. Found by starting a second node while the first was still up, which is the most
         * ordinary thing anybody does here.
         */
        await new Promise<void>((resolve, reject) => {
            server.once('error', (error: NodeJS.ErrnoException) => {
                reject(error.code === 'EADDRINUSE'
                    ? new Error(
                        `Port ${String(this.port)} is already in use on ${this.bindHost}. `
                        + `Another node is probably running — stop it, or start this one with `
                        + `--api <port>.`,
                    )
                    : error);
            });

            server.listen(this.port, this.bindHost, () => { resolve(); });
        });

        this.server = server;
    }

    public async onStop(): Promise<void> {
        const server = this.server;
        if (server === undefined) return;
        await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
        this.server = undefined;
    }

    /** The pipeline. Each stage either produces what the next needs, or refuses. */
    private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const broker = this.broker;
        if (broker === undefined) {
            send(response, { status: 503, body: { error: 'NOT_STARTED', message: 'The api is not started.' } });
            return;
        }

        const url = new URL(request.url ?? '/', 'http://placeholder');

        // 1. Which site. A connection that resolves to none is refused, never served by a default.
        const host = hostOf(request.headers, this.trustForwarded);
        const site = await broker.call('site.resolve_host', { host });
        if (site === undefined) {
            send(response, refuse('NO_SITE', `No site answers on "${host}".`));
            return;
        }

        const description = this.describe(site);

        // `_describe` is answered from the site already resolved, so there is no way to ask about
        // another one. See the note in `../contracts/site.contract.ts`.
        if (url.pathname === '/_describe') {
            send(response, { status: 200, body: publicDescription(description) });
            return;
        }

        // 2. Which route.
        const outcome = matchRoute(this.tableFor(description), request.method ?? 'GET', url.pathname);
        if (!outcome.found) {
            send(response, refuse(outcome.reason === 'no_route' ? 'NO_ROUTE' : 'METHOD_NOT_ALLOWED'));
            return;
        }
        const { call, params } = outcome.match;

        // 3. Which account. Absence is a valid answer; the gate decides whether it is enough.
        const caller = await this.callerOf(broker, request);

        // 4. The gate, then the scope.
        const entry = site.contracts.find((c) => c.key === call.key);
        if (entry === undefined) {
            // Unreachable via the table, which is built from the same list. Kept because "the table
            // and the site disagree" must never become "served anyway".
            send(response, refuse('EXPOSURE_MISMATCH'));
            return;
        }

        const memberships = caller === undefined ? [] : await this.membershipsOf(broker, caller.userId);

        const decision = gate({
            key: call.key,
            gate: gateOf(entry),
            caller,
            memberships,
            requestedScope: headerOf(request, SCOPE_HEADER),
            siteScope: site.organizationId,
        });

        if (!decision.allowed) {
            send(response, decision.response);
            return;
        }

        // 5. The input. Route over query over body, and a disagreement is an error.
        let body: Record<string, unknown>;
        try {
            body = await readJsonBody(request, this.maxBodyBytes);
        } catch (error) {
            send(response, error instanceof BodyTooLarge ? refuse('BODY_TOO_LARGE') : refuse('INVALID_JSON'));
            return;
        }

        const merged = mergeInput(params, decodeQuery(url.searchParams), body);
        if ('conflict' in merged) {
            send(response, refuse('INVALID_INPUT', merged.conflict));
            return;
        }

        const parsed = call.input.safeParse(merged.input);
        if (!parsed.success) {
            send(response, refuse('INVALID_INPUT', parsed.error.issues.map(issueLine).join('; ')));
            return;
        }

        // 6. The call. From here the contract's own failures are the caller's answer.
        try {
            const result = await callContract(broker, call.key, parsed.data, {
                user: caller === undefined ? undefined : {
                    id: caller.userId,
                    tenant_id: decision.resolvedScope ?? '',
                    roles: [...caller.roles],
                },
            });

            send(response, { status: 200, body: result as Record<string, unknown> });
        } catch (error) {
            send(response, errorResponse(error, logUnmapped));
        }
    }

    /**
     * The contracts this node has mounted, by key.
     *
     * Read from mesh's own registry rather than kept as a second list. A site naming something that
     * is not here is reported in the description's `unserved`, not silently dropped.
     */
    private describe(site: Site): SiteDescription {
        const mounted = new Map<string, ToolContract<z.ZodTypeAny, z.ZodTypeAny>>();
        for (const [key, contract] of globalContractRegistry.entries()) {
            if (contract.domain === API_DOMAIN) continue;
            mounted.set(key, contract);
        }

        return describeSite(site, mounted);
    }

    private tableFor(description: SiteDescription): readonly Route[] {
        const cached = this.tables.get(description.shapeHash);
        if (cached !== undefined) return cached;

        const table = routeTable(description.calls);
        this.tables.set(description.shapeHash, table);
        return table;
    }

    /**
     * Who is calling, from the `Authorization` header.
     *
     * **A bad ticket is the same as no ticket**, and that is not laziness. A caller presenting a
     * revoked credential to a public contract should be served, because the contract is public — and
     * telling them *your ticket is invalid* on an endpoint that never needed one is a distinction
     * with no use to them and some use to somebody testing tickets.
     */
    private async callerOf(broker: IServiceBroker, request: IncomingMessage): Promise<Caller | undefined> {
        const header = headerOf(request, 'authorization');
        if (header === undefined) return undefined;

        const [scheme, token] = header.split(' ');
        if (scheme?.toLowerCase() !== 'bearer' || token === undefined || token === '') return undefined;

        const validation = await broker.call('identity.ticket_validate', { ticket: token });
        if (!validation.valid || validation.userId === undefined) return undefined;

        return {
            userId: validation.userId,
            roles: validation.roles ?? [],
            provisional: validation.provisional === true,
        };
    }

    /**
     * The caller's own memberships.
     *
     * Unscoped, because this is what *produces* the scope. Narrowed to one `userId`, which is
     * stricter than the scope would have been.
     */
    private async membershipsOf(
        broker: IServiceBroker,
        userId: string,
    ): Promise<readonly { readonly organizationId: string }[]> {
        return broker.call('membership.find', { query: { userId }, limit: 100 });
    }
}

/**
 * Call a contract by key, with the caller's meta.
 *
 * The key is a string at run time — it came out of a database row — so this is the one place the
 * registry's typing cannot help, and the one place a cast is honest rather than lazy. It is narrow,
 * it is commented, and everything either side of it is checked: the key was matched against a
 * mounted contract, the input was parsed by that contract's schema, and the result is parsed by its
 * output schema inside the broker.
 */
async function callContract(
    broker: IServiceBroker,
    key: string,
    input: unknown,
    meta: Record<string, unknown>,
): Promise<unknown> {

    const registry = broker.getProvider<IServiceRegistry>('registry');
    const contract = registry.getTool(key);

    if (!contract) {
        throw new Error(`Contract not found: ${key}`);
    }

    return broker.call(key as keyof IServiceToolRegistry, input as any, { meta });
}

/**
 * An unmapped failure, to stderr, whole.
 *
 * **The caller gets a 500 with nothing in it and the operator gets everything**, which is the only
 * arrangement where both are right: a thrown message may carry a connection string or a query, and
 * the person running the node is the one who needs to see it.
 */
function logUnmapped(error: unknown): void {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`[api] unmapped failure — answered 500:\n${detail}\n`);
}

class BodyTooLarge extends Error { }

/**
 * Read and parse the body.
 *
 * **Refused at the limit rather than buffered and then measured**, which is the difference between
 * a 413 and an out-of-memory. A GET or an empty body is `{}` and not an error: a contract with no
 * required input is a real thing.
 */
async function readJsonBody(request: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
    if (request.method === 'GET' || request.method === 'HEAD') return {};

    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of request) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > limit) throw new BodyTooLarge();
        chunks.push(buffer);
    }

    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (raw === '') return {};

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new SyntaxError('The body must be a JSON object.');
    }

    return parsed as Record<string, unknown>;
}

/** A zod issue as one line, naming the field. A caller should not have to read a schema to fix it. */
const issueLine = (issue: { path: (string | number)[]; message: string }): string =>
    issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`;

function headerOf(request: IncomingMessage, name: string): string | undefined {
    const value = request.headers[name];
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === 'string' && first !== '' ? first : undefined;
}

/** The description a client is given. `unserved` is configuration detail and stays inside. */
function publicDescription(description: SiteDescription): Record<string, unknown> {
    return {
        host: description.host,
        title: description.title,
        description: description.description,
        shapeHash: description.shapeHash,
        calls: description.calls.map(describedCallSummary),
    };
}

function send(response: ServerResponse, result: ErrorResponse | { status: number; body: unknown }): void {
    const payload = JSON.stringify(result.body ?? null);
    response.writeHead(result.status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
    });
    response.end(payload);
}
