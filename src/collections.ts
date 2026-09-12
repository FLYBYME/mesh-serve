/**
 * Every collection this package serves, as modules.
 *
 * **One list, so a collection cannot be half-registered.** A node that mounts the contracts but not
 * the collection answers `find` with *"was not intercepted"*, and a node that mounts a collection
 * whose narrowing hook is attached to the wrong module answers it with every row. Both have
 * happened; both are invisible until something reads.
 *
 * See `./collection.js` for why each of these is its own module rather than a `mountCrud` call
 * inside the service that owns the behaviour.
 */

import { CollectionService, ownRowsOnly } from './collection.js';
import {
    membershipCrud, organizationCrud, ticketCrud, userCrud,
} from './identity/contracts/identity.contract.js';
import { siteCrud } from './serve/contracts/site.contract.js';

/**
 * The collections, in one array.
 *
 * `user` and `ticket` carry no hook because **every action on them is internal** — nothing outside
 * the mesh can reach them at all, so there is no caller to narrow to. If either is ever published,
 * it needs a hook before it is, and that is the note rather than the hook.
 */
export function collectionServices(): CollectionService[] {
    return [
        new CollectionService(userCrud),
        new CollectionService(organizationCrud),

        /**
         * **Narrowed to the caller's own rows, which is what `scopedBy` would have done.**
         *
         * It cannot be `scopedBy` — the scope is resolved *from* this collection, so demanding a
         * resolved scope refuses the read that produces one. See `membershipCrud`.
         *
         * `find_one` and `count` are narrowed alongside `find`, because a caller who cannot list
         * somebody else's memberships must not be able to count them either. A narrowing applied to
         * the obvious read and not its two siblings is the shape that gets found by somebody
         * enumerating with `count`.
         */
        new CollectionService(membershipCrud, {
            hooks: {
                find: { before: ownRowsOnly('userId') },
                find_one: { before: ownRowsOnly('userId') },
                count: { before: ownRowsOnly('userId') },
            },
        }),

        new CollectionService(ticketCrud),

        /**
         * **No hook, and that is B1 rather than an omission.**
         *
         * A site is a public collection: it must be readable with no caller, because resolving a
         * hostname is the first thing every request does. What gates a *write* against its owner
         * field is `spec/questions.md` **B1**, which the spec says blocks every public collection
         * and is not answered. Until it is, `site.create` is reachable only where a site exposes it.
         */
        new CollectionService(siteCrud),
    ];
}
