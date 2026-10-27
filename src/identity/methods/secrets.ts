import { z, type Database, type IServiceContext } from '@flybyme/mesh';

/**
 * The hidden fields identity itself needs the value of: a password's hash to check a sign-in, a
 * ticket's stored hash for its revoked event. `hidden` strips them from every read, `ctx.db`'s too,
 * so these read the store as it is (Database.repo, the escape hatch `hidden` names) -- here and
 * nowhere else, and never answered to a caller.
 */
const PasswordRow = z.object({ id: z.string(), passwordHash: z.string().optional() });
const TicketRow = z.object({ id: z.string(), token: z.string() });

function database(ctx: IServiceContext): Database {
    return ctx.broker.getProvider<Database>('database');
}

/** An account's password hash, or undefined when it has none. */
export async function passwordHashOf(ctx: IServiceContext, userId: string): Promise<string | undefined> {
    const row = await database(ctx).repo(PasswordRow, 'identity.user').findOne({ id: userId });

    return row?.passwordHash;
}

/** What a ticket stores for its token (its sha256), for the revoked event's `tokenId`. */
export async function ticketHashOf(ctx: IServiceContext, ticketId: string): Promise<string> {
    const row = await database(ctx).repo(TicketRow, 'identity.ticket').findOne({ id: ticketId });

    return row?.token ?? '';
}
