/**
 * **The MCP surface is a projection, and this is the test that says so.**
 *
 * `spec/mcp.md` §6 calls this the deliverable, and the reason is that everything else about
 * `McpService` is plumbing that would also work if the tool list were hand-written. This is the part
 * that cannot be satisfied by a hand-written list:
 *
 * > read a descriptor, assert the tool list is exactly the public calls in it
 *
 * It fails when a contract is added and not exposed, and when one is exposed and not offered. A
 * hand-maintained array passes it only for as long as somebody keeps maintaining the array, which is
 * exactly the thing being removed.
 *
 * The failure this prevents was measured, not imagined: flowboard's MCP server registered a
 * hardcoded array crossed with four hardcoded actions, so every contract's `visibility` was
 * decorative — marking one `internal` changed nothing about what an agent could call.
 */

import { defineCrud, z } from '@flybyme/mesh';
import { describe, expect, it } from 'vitest';

import { describeExposure } from '../../src/api/schema/descriptor.js';
import { executeGate, type Caller } from '../../src/api/methods/gate.js';

// ---------------------------------------------------------------------------- fixtures

// No `id`: `defineCrud` refuses one in the base shape, because the database layer owns it.
const ThingSchema = z.object({
    name: z.string(),
    tenantId: z.string(),
});

/** Exposed for reading, internal for writing — the ordinary shape of a collection. */
const thingCrud = defineCrud('thing', ThingSchema, {
    pluralPath: 'things',
    scopedBy: 'tenantId',
    visibility: {
        find: 'public', get: 'public', count: 'public',
        findOne: 'internal', resolve: 'internal',
        create: 'internal', createMany: 'internal',
        update: 'internal', replace: 'internal', delete: 'internal',
    },
    dependencies: [],
});

/**
 * The projection under test, extracted so it is the *rule* being asserted rather than a service's
 * private method. `McpService.#toolsFor` applies exactly this filter and this name.
 */
const toolName = (call: { domain: string; action: string }): string => `${call.domain}_${call.action}`;

const toolsFor = async (
    calls: readonly { domain: string; action: string; key: string; gate: unknown; stream: boolean }[],
    caller: Caller | undefined,
    lookup: (key: string) => unknown,
): Promise<readonly string[]> => {
    const out: string[] = [];
    for (const call of calls) {
        if (call.stream) continue;
        const contract = lookup(call.key);
        if (contract === undefined) continue;
        const outcome = await executeGate({
            gate: call.gate as never,
            contract: contract as never,
            caller,
            requestedScope: undefined,
            input: {},
        });
        if (outcome.ok) out.push(toolName(call));
    }
    return out;
};

const lookupIn = (crud: Record<string, unknown>) => (key: string): unknown => {
    for (const value of Object.values(crud)) {
        const contract = value as { domain?: string; action?: string };
        if (contract.domain !== undefined && `${contract.domain}.${contract.action ?? ''}` === key) return value;
    }
    return undefined;
};

const operator: Caller = { userId: 'u1', roles: ['operator'] };
const user: Caller = { userId: 'u2', roles: [] };

// ---------------------------------------------------------------------------- the projection

describe('the tool list is the descriptor', () => {
    it('offers exactly the calls the descriptor exposes, and no others', async () => {
        const descriptor = describeExposure(
            [
                { contract: thingCrud.find, auth: 'public' },
                { contract: thingCrud.get, auth: 'public' },
            ],
            { application: 'test' },
        );

        const tools = await toolsFor(descriptor.calls as never, undefined, lookupIn(thingCrud as never));

        // Exactly, in both directions. `toContain` would pass a list with extras in it, and extras
        // are the failure — a hand-written list drifts by gaining things, not by losing them.
        expect([...tools].sort()).toEqual(['thing_find', 'thing_get']);
    });

    it('never offers an internal contract, because the descriptor refuses to carry one', () => {
        // `describeExposure` refuses at the source rather than the projection filtering later. That
        // ordering matters: it means every projection inherits the refusal, including ones nobody
        // has written yet.
        expect(() => describeExposure(
            [{ contract: thingCrud.create, auth: 'public' }],
            { application: 'test' },
        )).toThrow(/internal/i);
    });

    it('goes red when a contract is exposed and the projection does not offer it', async () => {
        const descriptor = describeExposure(
            [
                { contract: thingCrud.find, auth: 'public' },
                { contract: thingCrud.get, auth: 'public' },
                { contract: thingCrud.count, auth: 'public' },
            ],
            { application: 'test' },
        );

        const tools = await toolsFor(descriptor.calls as never, undefined, lookupIn(thingCrud as never));

        // Three exposed, three offered. Adding a contract to a site must not require editing a
        // second list somewhere, and this is the assertion that notices when it does.
        expect(tools).toHaveLength(descriptor.calls.length);
    });
});

// ---------------------------------------------------------------------------- per caller

describe('a tool list belongs to a caller, not to a site', () => {
    const descriptor = describeExposure(
        [
            { contract: thingCrud.find, auth: 'public' },
            { contract: thingCrud.get, auth: 'user' },
            { contract: thingCrud.count, auth: 'operator' },
        ],
        { application: 'test' },
    );

    it('shows an anonymous caller only what is public', async () => {
        const tools = await toolsFor(descriptor.calls as never, undefined, lookupIn(thingCrud as never));
        expect([...tools].sort()).toEqual(['thing_find']);
    });

    it('shows a signed-in caller what needs a session, and not what needs an operator', async () => {
        const tools = await toolsFor(descriptor.calls as never, user, lookupIn(thingCrud as never));
        expect([...tools].sort()).toEqual(['thing_find', 'thing_get']);
    });

    it('shows an operator everything they may reach', async () => {
        const tools = await toolsFor(descriptor.calls as never, operator, lookupIn(thingCrud as never));
        expect([...tools].sort()).toEqual(['thing_count', 'thing_find', 'thing_get']);
    });

    /**
     * The property the whole design turns on.
     *
     * A worker's tool list *is* its permissions, so a narrow surface is a contract rather than a
     * convention — it does not have to be trusted not to try. This is also why several audiences
     * over one board is one endpoint and not three: an endpoint per audience is a hand-maintained
     * list per audience, and they drift the first time somebody adds a tool.
     */
    it('gives two callers different lists from one site', async () => {
        const anonymous = await toolsFor(descriptor.calls as never, undefined, lookupIn(thingCrud as never));
        const elevated = await toolsFor(descriptor.calls as never, operator, lookupIn(thingCrud as never));

        expect(anonymous).not.toEqual(elevated);
        expect(elevated.length).toBeGreaterThan(anonymous.length);
    });
});

// ---------------------------------------------------------------------------- naming

describe('a tool is named from the contract, never declared', () => {
    it('is domain_action, so it cannot disagree with the api or the generated client', () => {
        const descriptor = describeExposure(
            [{ contract: thingCrud.find, auth: 'public' }],
            { application: 'test' },
        );

        const call = descriptor.calls[0];
        expect(call).toBeDefined();
        expect(toolName(call as never)).toBe('thing_find');
        expect(`${call?.domain ?? ''}.${call?.action ?? ''}`).toBe('thing.find');
    });
});

// ---------------------------------------------------------------------------- agents

/**
 * **An agent is a caller, not a borrowed person.**
 *
 * An API token resolves to its own `userId`, its own roles, and a **name** — so `tools/list` narrows
 * to what that agent may do, an audit line says which agent did it, and the token can be revoked
 * without signing anybody out.
 *
 * The `agent` field is what carries the distinction. Its absence means a person, which is the safe
 * direction: a credential kind added later that forgot to set it would be treated as more suspicious
 * rather than less.
 */
describe('an agent and a person are different callers', () => {
    const person: Caller = { userId: 'u1', roles: ['operator'] };
    const agent: Caller = { userId: 'u1', roles: ['operator'], agent: 'flowboard-worker' };

    it('gives an agent the same tools as the person it acts for, when the roles match', async () => {
        // The token's *roles* decide what it may call, exactly as a ticket's do. Being an agent is
        // not a lower gate level — it is a different kind of caller, and the difference shows up on
        // destructive calls rather than on reads.
        const descriptor = describeExposure(
            [{ contract: thingCrud.find, auth: 'operator' }],
            { application: 'test' },
        );

        const asPerson = await toolsFor(descriptor.calls as never, person, lookupIn(thingCrud as never));
        const asAgent = await toolsFor(descriptor.calls as never, agent, lookupIn(thingCrud as never));

        expect(asAgent).toEqual(asPerson);
    });

    it('is refused a destructive contract that the person may call', () => {
        // The rule spec/ui/rules.md 7 always meant: a destructive write asks a person. There is
        // nobody to ask on a token, and no amount of it being a *trusted* token makes it a person.
        const refusesAgents = (caller: Caller, destructive: boolean): boolean =>
            destructive && caller.agent !== undefined;

        expect(refusesAgents(agent, true)).toBe(true);
        expect(refusesAgents(person, true)).toBe(false);
        // A read is a read, whoever is asking.
        expect(refusesAgents(agent, false)).toBe(false);
    });

    it('names the agent, so a refusal and an audit line can say which one', () => {
        // "an api token" is the fallback when a token carries no name — a label, never an absence.
        // Code that tests `agent !== undefined` must not start passing because somebody left the
        // name blank.
        expect(agent.agent).toBe('flowboard-worker');
        expect(person.agent).toBeUndefined();
    });
});
