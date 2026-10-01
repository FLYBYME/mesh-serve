import { defineContract, defineCrud, z } from '@flybyme/mesh';

import { activitySchema } from '../schema/activity.js';

/**
 * The activity log (methods/activity.ts). Written by the api gateway alone; read by operators.
 * Global, not scoped: an operator's calls run in the api's own organization, and the log is
 * every organization's -- each row names the one it ran in. Rows expire after 90 days (a TTL index
 * the gateway ensures), so it can never fill the database the way stored builds did.
 */
export const activityCrud = defineCrud('serve.activity', activitySchema, {
    pluralPath: 'activity',
    delivery: 'global',
    dependencies: [],
    permissions: ['operator'],
    visibility: {
        find: 'public', findOne: 'public', get: 'public', count: 'public',
    },
    filePath: 'src/api/contracts/activity.contract.ts',
});

export const activityMineInputSchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50).describe('How many, newest first'),
    before: z.coerce.date().optional().describe('Only rows before this time -- the next page: the last row\'s `at`'),
}).describe('My organization\'s activity');

export const activityMineOutputSchema = z.object({
    rows: z.array(z.object({
        at: z.coerce.date(),
        contract: z.string(),
        outcome: z.enum(['ok', 'refused', 'failed', 'held']),
        actor: z.object({ userId: z.string(), viaApiToken: z.boolean(), agentName: z.string().optional() }),
        input: z.string(),
        error: z.string().optional(),
    })),
}).describe('What was changed in my organization, by whom, newest first -- addresses and clients left out');

/**
 * A customer's own activity: what was done in their organization -- by their people, their agents'
 * tokens, or the platform's operators acting for them. The organization is the one the call runs
 * in (the gateway's, membership-checked), never one named in the input; where the call came from
 * (address, user agent) stays the operator's.
 */
export const activityMineContract = defineContract({
    domain: 'serve.activity',
    action: 'mine',
    description: 'What was changed in my organization, by whom, newest first.',
    inputSchema: activityMineInputSchema,
    outputSchema: activityMineOutputSchema,
    rest: { method: 'GET', path: '/activity/mine' },
    visibility: 'public',
    dependencies: ['serve.activity'],
    filePath: 'src/api/tools/activityMine.ts', concurrency: 'on-demand', permissions: [],
    print: (o) => o.rows.map((r) => `${r.at.toISOString()} ${r.outcome} ${r.contract}`).join('\n'),
});

export type ActivityMineInput = z.infer<typeof activityMineContract.inputSchema>;
export type ActivityMineOutput = z.infer<typeof activityMineContract.outputSchema>;
