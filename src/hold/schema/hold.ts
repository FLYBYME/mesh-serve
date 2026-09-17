import { z } from 'zod';

export const holdRequestedBySchema = z.object({
    userId: z.string().describe('The account the calling credential acts as'),
    agent: z.string().optional().describe('The API token\'s own name; absent when a person asked, not an agent'),
    roles: z.array(z.string()).describe('Roles the caller held at the moment the call was placed on hold'),
}).describe('Who asked for the held call, and how');

export const holdSchema = z.object({
    tenantId: z.string().describe('The organization whose api this call arrived on'),
    call: z.string().describe('The domain.action contract this call would invoke if released'),
    host: z.string().describe('The api hostname the call arrived on'),
    input: z.record(z.unknown()).describe('The frozen input of the call, exactly as the agent sent it'),
    requestedBy: holdRequestedBySchema,
    // `z.coerce.date()`, not `z.string()`, matching createdAt/updatedAt -- see queue/schema/queue.ts
    // for the full reasoning (mesh's JSONSerializer revives an ISO-instant string into a real Date
    // crossing a network hop, which fails a z.string() field's own schema on the way back from
    // exactly the kind of leaderScoped call decide.ts now is).
    requestedAt: z.coerce.date().describe('When the call was placed on hold'),
    status: z.enum(['held', 'released', 'rejected', 'expired']).default('held'),
    expiresAt: z.coerce.date().describe('When a still-held row is treated as expired'),
    decidedBy: z.string().optional().describe('The account that released or rejected this'),
    decidedAt: z.coerce.date().optional().describe('When it was decided'),
    reason: z.string().optional().describe('Why it was rejected, if the decider gave one'),
    result: z.unknown().optional().describe('The replayed call\'s own result, once released'),
    error: z.string().optional().describe('The replayed call\'s own error message, if releasing it failed'),
}).describe('A call an agent asked to make, frozen and held until an operator decides it');
