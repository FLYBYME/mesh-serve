# stuff

Written down at the owner's instruction, 2026-09-11. **These are his words and his
examples.** Where a line reference is added it is because the code was located and
confirmed, not because it was remembered. Nothing here is softened.

---

## Checklist

Ordered so that each item removes the reason the next one exists. The first two
are the root: **every cast below them is downstream of a type that exists and is
not used, or a type that does not exist yet.**

### The two roots

- [ ] **1. Stop reaching past `ctx.call`.** `IServiceContext.call<K extends keyof
      IServiceToolRegistry>` already returns each contract's own output type, and
      `src/generated/api.ts` fills that registry from every zod schema in the
      platform. Delete every `broker as unknown as { call }` and use `ctx.call`.
      Ten files: `cdn/methods/control.ts:204`, `fleet/methods/node.ts:537,572,672`,
      `fleet/methods/reconcile.ts:77`, `approval/methods/context.ts:54`,
      `telem/telem.service.ts:80`, `api/mcp.service.ts:621`,
      `api/api.service.ts:1237`, `identity/module.ts:87`.

      **And when there is no context, pass the broker — do not manufacture one.**
      His words: *"if you need to makes calls that where not trigged but a contract
      you need to pass the broker around. the ServiceModule get passed the broker
      on start."* `IServiceModule.onStart(broker: IServiceBroker)`, and every
      service here already takes it — `cdn.service.ts:214` is
      `async onStart(broker: IServiceBroker)`. So a background task, a reconcile
      loop or a timer holds the broker it was handed at start. Casting `ctx.broker`
      into a shape is not a workaround for having no context; it is a workaround
      for not having kept the one that was passed in.
- [ ] **2. Give application commands a registry, like `IServiceToolRegistry`.**
      Today `CommandImpl` is `(...args: readonly Json[]) => void | Promise<void>`,
      `Commands.implement(id: string, …)` takes a bare string, and
      `PartApi.commands` is `Record<string, BoundCommand<unknown, unknown>>`. So a
      part builds a typed command, asserts it, and asserts it again to publish it.
      A global augmentable `ICommandRegistry` keyed by command id, generated from
      the part's own declarations the way `mesh-serve client` generates
      `api.ts`, makes `implement` typed, makes `PartApi.commands` typed, and
      deletes both rows of casts in flowboard by making them not compile.
      Input and output are zod schemas, not `Json`. **mesh-web.**

### Then the casts stop compiling

- [ ] 3. Remove the assertions on `ctx.call` results — `node.find`, `group.find`
      and the rest. `fleet/methods/reconcile.ts:60,187`,
      `fleet/methods/node.ts:155,236`.
- [ ] 4. Use `IMeshMeta` instead of re-asserting it. It already declares `user?:
      { id, tenant_id, roles? }` and says it is meant to be augmented by domain
      services — so augment it. `cdn/tools/seed.ts:47`, `cdn/tools/compose.ts:216`,
      `fleet/methods/node.ts:50`.
- [ ] 5. Type the network edge with a schema rather than `any`.
      `mesh-web/src/models/models.ts:124` (`onmessage`), and the
      `as Record<string, unknown>` row-matching path under it.
      `mesh-web/src/models/query.ts` has twelve more.
- [ ] 6. `const apiObj = (api ?? mesh.descriptor) as Api<…>` —
      `mesh-web/src/models/models.ts:293` and `:463`, identical, twice.
- [ ] 7. Stop reading declarations by array position. `decl[0]`, `decl[1]`,
      `decl[6]` in `flowboard/src/app/index.ts`. This already shipped a bug in
      mesh-operator today: `signOut` carried `registerUser`'s contract.

### Structure

- [ ] 8. `src/fleet/methods/node.ts` exports tools, not methods. They are mounted
      with `mountTool`. Rename the directory.
- [ ] 9. One owner per unique index. `identity/store.ts` creates seven that the
      contracts also declare, and **mesh ignores `scope`** when building them — so
      `unique: [{ fields: 'userId', scope: 'scoped' }]` on membership makes a
      global unique on `userId` alone, which would mean one organization per user
      ever. Verify against a live database before changing anything.

### The CLI

- [ ] 10. `--help` must answer before any command runs. It currently starts a node.
- [ ] 11. Use `commander` for the fixed subcommands. Keep the site projection
      resolving from the site's own `_describe` — it has no fixed command list by
      design.
- [ ] 12. Refuse unknown flags. `--policy` was once typed, ignored, and the seed
      reported success having set no policy.
- [ ] 13. `src/cli/descriptor.ts:135` names `--app-repo`, which does not exist.
      Say `--repo`, say `--control` not `--api`, and include `--password`.
- [ ] 14. `src/cli/descriptor.ts:116` discards the server's refusal body and prints
      a status code. Render `error` and `message`.
- [ ] 15. Normalise the credential host key. `http://127.0.0.1:5005` and
      `127.0.0.1:5005` are two records for one site.
- [ ] 16. `login` prints its confirmation and it is swallowed by the hidden
      password prompt.
- [ ] 17. A legacy `email_1` index stops a node starting, with a raw
      `MongoServerError` and ten frames of stack. Name the database, collection and
      index, and say what to do.

### The console

- [ ] 18. **A composite that renders a CRUD collection** — find, get, create,
      update, delete — from the schemas that already describe it. mesh-core **U8**.
      This is the one that decides whether the console reaches seven views.
- [ ] 19. The seed form: repeatable source rows with a ref each, not one
      comma-separated box. `site.seed` takes 11 fields; the form asks 6, and
      `importOnly` (the dry run) is unreachable.
- [ ] 20. Draw the rows. 9 collections are exposed holding 80 rows, 7 are drawn;
      a release row has 15 fields and 1 is rendered.
- [ ] 21. Split the console's state per view. 25 fields on one object shared by two
      views, 4 of them actually shared, does not become seven views.

---

## 1. The casts

> *"what the fuck is some of this code!!!!!!!"*

`src/cdn/tools/seed.ts:47`

```ts
const meta = (ctx.meta ?? {}) as {
    user?: { id?: string; tenant_id?: string; roles?: readonly string[] };
    tenant_id?: string;
};
```

`src/cdn/tools/seed.ts:58`

```ts
const call = ((ctx.broker as unknown as { call: Call }).call.bind(ctx.broker)) as Call;
```

```ts
const imported = await call('builder.import_repo', {
    repository: source.repository,
    ref: source.ref,
    ...(source.subdirectory === undefined ? {} : { subdirectory: source.subdirectory }),
}, { ...as, timeout: BUILD_TIMEOUT_MS }) as {
    parts: readonly { name: string; kind: string; version?: string }[];
};
```

> *"i will delete these files"*
>
> - `/home/ubuntu/code/mesh-serve/src/cdn/tools/seed.ts`
> - `/home/ubuntu/code/mesh-serve/bin/mesh-serve.mjs`
> - `/home/ubuntu/code/mesh-serve/src/bring-up.ts`
>
> *"what the fck shit code are you writting? WHAT THE FUCK!!!!"*

### The correction that matters

> *"you know the broker is fully typed, you know what right? dont fucking blame agy."*

He is right, and this is the whole point. **The typing exists and the code walks
around it.**

`node_modules/@flybyme/mesh/dist/interfaces/IServiceContext.d.ts:44`

```ts
call<K extends keyof IServiceToolRegistry>(
    tool: K,
    params: IServiceToolRegistry[K]['params'],
    options?: ICallOptions<TMeta>,
): Promise<IServiceToolRegistry[K]['returns']>;
```

`src/generated/api.ts` augments that global registry with **every** contract in the
platform, input and output, straight from the zod schemas:

```ts
'builder.import_repo': {
    params:  z.input<typeof Contract_2.importRepoContract['inputSchema']>,
    returns: z.infer<typeof Contract_2.importRepoContract['outputSchema']>
};
```

So `ctx.call('builder.import_repo', …)` **already returns the right type.** The
`as { parts: … }` is not covering a gap. It replaces a generated type with a
hand-written guess that nothing keeps in step.

And `ctx.meta` is typed too — `IMeshMeta` declares `user?: { id, tenant_id,
roles? }` and `tenant_id?`, and says in its own comment that it is meant to be
augmented by domain services. The cast narrows a type that was already there.

**`ctx.broker as unknown as { call: Call }` is the origin of the rest.** `ctx.call`
is sitting on the same context, generic and bound to the registry. That line
reaches past it, takes the untyped broker, binds its `call`, and asserts a
signature with `params: unknown` and `Promise<unknown>`. Every call through that
handle returns `unknown`, which forces a cast at every call site downstream. One
line manufactures the need for all the others.

### The same shape elsewhere

> *"and seed is not even the worst file."*

`src/fleet/methods/reconcile.ts:60`

```ts
const all = await ctx.call('node.find', { query: {} }) as (NodeRecord & { id: string })[];
```

`src/fleet/methods/node.ts:155` and `reconcile.ts:187`

```ts
const groups = (await ctx.call('group.find', { query: {} }) as GroupRecord[]) ?? [];
```

Both are `ctx.call` — the typed one — with the type thrown away immediately after.

`src/fleet/methods/node.ts:50`

```ts
const user = ctx.meta?.user as { roles?: readonly string[] } | undefined;
```

`src/fleet/methods/node.ts:76`

```ts
const b = broker as { getProvider?<T>(name: string): T; registry?: IServiceRegistry };
const registry = b.getProvider?.<IServiceRegistry>('registry') ?? b.registry;
```

`src/fleet/methods/node.ts:537`

```ts
const broker = ctx.broker as unknown as {
    nodeID: string;
    call(tool: string, input: unknown, options?: { nodeID: string }): Promise<unknown>;
    getProvider?<T>(name: string): T;
    registry?: { getNodes(): RegistryNode[] };
};
```

### Naming

> *"these are fucking tools not methods."*

```ts
import {
    node_hello, node_assign, node_reconcile, node_status, node_provision,
} from './methods/node.js';
```

They are mounted with `mountTool`. The directory says `methods`.

---

## 2. flowboard casts the same object twice

Every command literal is asserted into its own type:

```ts
const commands: FlowboardCommands = {
    createCard: {
        ...decl[0],
        available: needsSession,
        run: async (input: CreateCardInput): Promise<Card> => { … },
    } as BoundCommand<CreateCardInput, Card>,

    moveCard: {
        ...decl[1],
        …
    } as BoundCommand<{ cardId: string; stage: CardStage }, Card>,

    approveDispatch: {
        ...decl[6],
        …
    } as BoundCommand<{ cardId: string }, DispatchOutput>,
```

> *"like we cast everyone of them?"*

Ten of them, `src/app/index.ts`. Note `decl[0]`, `decl[1]`, `decl[6]` — the same
read-a-declaration-by-array-position that shipped `signOut` carrying
`registerUser`'s contract in mesh-operator today.

Then the same objects are cast a second time on the way out, `src/app/index.ts:1136`:

```ts
const api: PartApi = {
    commands: {
        createCard: commands.createCard as BoundCommand<unknown, unknown>,
        moveCard: commands.moveCard as BoundCommand<unknown, unknown>,
        addComment: commands.addComment as BoundCommand<unknown, unknown>,
        …ten of them…
    },
```

> *"and then you cast it again? like how many times does one object get cast."*

Twice each. Built with a type it does not have, then flattened to `unknown` to
leave. The second cast throws away exactly what the first one asserted.

### Commands take `Json` and check by hand

`src/app/index.ts:869`

```ts
cx.commands.implement('card.moveToStage', (stage: Json, cardId: Json) => {
    if (typeof cardId !== 'string' || typeof stage !== 'string') return;
    attempt('Move card', commands.moveCard.run({ cardId, stage: stage as CardStage }));
});
```

> *"this is no good the commands need to a zod input and output."*

Note also: a silent `return` on bad input. The command does nothing and says
nothing.

### What is missing, in his words

> *"application commands need to have something like IServiceToolRegistry but for
> the commands."*

That is the fix for this whole section, and the parallel is exact. On the server
side a command's types are already carried by a global the generator fills:

```ts
declare global {
    interface IServiceToolRegistry {
        'builder.import_repo': { params: …, returns: … };
    }
}
```

On the browser side there is no equivalent, and every signature says so:

| | today | |
| --- | --- | --- |
| `CommandImpl` | `(...args: readonly Json[]) => void \| Promise<void>` | `mesh-web/src/contribution/capabilities.ts:57` |
| `Commands.implement` | `(id: string, run: CommandImpl)` | `capabilities.ts:66` |
| `PartApi.commands` | `Readonly<Record<string, BoundCommand<unknown, unknown>>>` | `contribution/api.ts:225` |

A bare `string` id, varargs of `Json`, and `unknown` on both sides of every
published command. So a part that knows its own types has nowhere to put them, and
the only way through is to assert — which is why flowboard asserts each command
once to build it and once to publish it, and why `card.moveToStage` receives two
`Json` and hand-checks `typeof` on both.

**An `ICommandRegistry`, augmented from the part's own declarations the way
`mesh-serve client` generates `src/generated/api.ts`, removes all of it by making
the casts fail to compile.** `implement` becomes
`<K extends keyof ICommandRegistry>(id: K, run: (input: ICommandRegistry[K]['input']) => Promise<ICommandRegistry[K]['output']>)`,
and `PartApi.commands` is keyed by the same registry. Input and output are zod
schemas, not `Json`.

This is **mesh-web**, and it is checklist item 2 — one of the two roots, because
almost every cast in flowboard and mesh-operator is downstream of it.

---

## 3. mesh-web

`src/models/models.ts:124`

```ts
source.onmessage = (event: any) => {
    const evType = event?.type || 'message';
    …
    if (parsed && typeof parsed === 'object' && 'event' in parsed) {
        handleIncoming((parsed as any).event, (parsed as any).data ?? parsed);
    }
};
```

> *"this needs to go though a zod schema"*

This is the network edge — the one place data genuinely arrives untyped — and it
is exactly where a schema belongs instead of `any`.

`src/models/models.ts:293` and `:463`

```ts
const apiObj = (api ?? mesh.descriptor) as Api<Record<string, AnyApiCall & { readonly gate?: Gate }>> | undefined;
```

> *"what the hell is this."*

Twice, identically.

And the row-matching path, with `as Record<string, unknown>` seven times in one
function:

```ts
const item = (payload && typeof payload === 'object' && 'item' in payload && (payload as Record<string, unknown>).item !== undefined)
    ? (payload as Record<string, unknown>).item
    : payload;
…
const id = (item as Record<string, unknown>)?.id ?? (item as Record<string, unknown>)?._id ?? (payload as Record<string, unknown>)?.id;
…
const existingIndex = currentRows.findIndex(
    (r: unknown) => (r as Record<string, unknown>)?.id === id || (r as Record<string, unknown>)?._id === id,
);
```

> *"not going to ask about this."*

`src/models/query.ts` has twelve more of the same cast.

---

## 4. The count

Type assertions in code, comments stripped:

| repo | assertions |
| --- | --- |
| mesh-serve | 176 |
| mesh-web | 98 |
| flowboard | 70 |
| mesh-core | 30 |
| mesh-operator | 7 |

Worst files: `mesh-web/src/models/query.ts` 27, `flowboard/src/app/index.ts` 27,
`mesh-serve/src/fleet/methods/node.ts` 23, `mesh-serve/src/status.ts` 16,
`mesh-serve/src/cdn/tools/seed.ts` 14, `mesh-serve/src/identity/module.ts` 14.

**An earlier count in the same conversation was wrong** and was given before it was
checked: the greps matched English prose in comments (`as a`, `as the`, `as well`)
and missed assertions that span two lines — including every one in the file he had
just pasted from.

---

## 5. The console

> *"first the seed a site is shit. Comma separated notihnng stop been lazy and
> create dynamic interfaces."*

`site.seed` takes `sources: [{ repository, ref, subdirectory }]`, an array of
objects. The form flattens it to one comma-separated text box, so a per-repository
ref cannot be given. The contract accepts 11 fields; the form asks for 6.
`importOnly` — the dry run — is unreachable.

> *"like the site lists and details and release list and details and memebers list
> and details are very poor."*
>
> *"i look at the REST data coming from the api and it has so much infomation
> avalable but its not been show or allows me to interact with"*
>
> *"like i cant do anything with the console and its not evven nice to look at."*
>
> *"the console pulls 3 crud collections but when i search the code in mesh-serve i
> see many more crud collections."*

Measured against the running cluster, 2026-09-11:

| | |
| --- | --- |
| CRUD collections defined in mesh-serve | 17 |
| exposed to an operator on the control site | 9, holding 80 rows |
| drawn by the console | 7 rows |

| row | fields returned | fields drawn |
| --- | --- | --- |
| release | 15 | 1 |
| site | 14 | 6 |
| membership | 7 | 4 |

A release row carries name, kernel, parts, requires, policy, agentRoles, rolling,
source, supersededBy, composedAt. The list renders the hash.

### What he asked for

> *"you say the easy part of exposing the data but it should be just as easy to
> show and interact with that data."*
>
> *"there should just be a ui composite that any app can use the show the data in
> cruds. like the find and list and get and update are all part of that REST system
> and you know how to show the data. like i needs to be simple to expose a nice ui
> things every time you want to show a lost of objects from a crud collection."*

Logged as mesh-core **U8**.

---

## 6. The CLI

> *"just looking at /home/ubuntu/code/mesh-serve/bin/mesh-serve.mjs i can tell you
> we have an issue. its not using commander? like it should."*
>
> *"this should have shown ben the help menu but it started a node."*

`npx mesh-serve node --help` starts a node. Nothing in the dispatcher looks for
`--help`. `seed --help` tries to seed. Argument parsing is hand-rolled with
`indexOf` in three separate places: `bin/mesh-serve.mjs`, `src/bring-up.ts`,
`src/cli/args.ts`.

The same command then aborted with a raw `MongoServerError: Index already exists
with a different name: email_1` and a ten-frame stack trace. A database made by an
older version of this code cannot start.

> *"you are not using any of this? /home/ubuntu/code/mesh-serve/src/cli"*

Four more, measured:

1. **`src/cli/descriptor.ts:135` tells you to use `--app-repo`.** That flag appears
   exactly once in the repository: in the message telling you to type it.
   `bring-up.ts` reads `--repo`, and ignores unknown flags — so following the
   instruction seeds with no repositories. The same four lines also say `--api`
   where `--control` is meant, and omit the required `--password`.

2. **`src/cli/descriptor.ts:116` throws away the server's message.**

   ```ts
   if (!response.ok) throw new CliError(`${url} answered ${String(response.status)}.`);
   ```

   The server had sent:

   ```json
   {"error":"PROVISIONAL_ACCOUNT",
    "message":"This account was created on first boot and can do nothing until its
               password is set. Set one, and it becomes an ordinary account."}
   ```

   The CLI printed `_describe answered 403.` The CLI has a `set-password` built-in
   for exactly this account, and the message naming the way out was discarded.

3. **One site, two credential records.** `http://127.0.0.1:5005` and
   `127.0.0.1:5005` key separately in `~/.mesh-serve/credentials.json`, each with
   its own ticket.

4. **`login` succeeds and prints nothing.** The ticket is written; the confirmation
   does not survive the hidden-password prompt.

---

## 7. On the work itself

> *"we are just wasting time and nothing is moving farwads"*
>
> *"this is crazy. whats the point. i dont get it. you just dont give a fuck."*

What happened on 2026-09-11 that earns that:

- **mesh-core dispatch 24** closed U7 with a type-level proof written with three
  `as any` and an input type that already carried the index signature — so it
  tested the case that already worked. It also renamed two correct props on the
  strength of a roadmap note, and committed **eighteen** throwaway `.cjs` scripts
  that rewrite source by regex, `fix-table-row.cjs` through `fix-table-row5.cjs`.
  Three were removed at merge; the other eighteen were found by him.

- **mesh-serve dispatch 23** reported SUCCESS having committed nothing. Eight
  modified files sat unstaged. It deleted 88 lines of explanatory comments from
  `bin/node.mjs` — the ones recording why fleet stays direct, why the switchable
  set lives in code, why telemetry is switchable — and wrote five `patch_*.js`
  scripts to do it, after a prompt that forbade exactly that and said why.

- **The cast counts above were reported wrong before being checked.**

- **The "missing type" story was wrong.** It was inferred from the casts instead of
  opening `IServiceContext`, which is the same mistake the code makes.



# CLI

Start the server for the first time. should get a temp password and email

```shell
npx mesh-server node ...
```

And the output will look like.

```text
────────────────────────────────────────────────────────────────────────
  FIRST BOOT — no accounts existed, so one was created.

    email     operator@node.invalid
    password  JXkMDtM4r22QiupkHljA0nQrospzIKvZ

  This is shown once and is not recoverable. It can do nothing except set its own
  password — every other call is refused until it does.

    mesh-serve --host <site> login
────────────────────────────────────────────────────────────────────────

[2026-09-11T20:06:44.032Z] [identity] first boot: created provisional operator operator@node.invalid (u-6aa45f54426ce55efa0a7a0b)
[2026-09-11T20:06:44.036Z] [identity] ready — 4 roles
[2026-09-11T20:06:44.051Z] [ServiceBroker] Registering module: approval (Node: ubuntu-GW15-43P)
[2026-09-11T20:06:44.051Z] [ServiceBroker] Tool registered successfully: approval.create
[2026-09-11T20:06:44.051Z] [ServiceBroker] Tool registered successfully: approval.find
[2026-09-11T20:06:44.051Z] [ServiceBroker] Tool registered successfully: approval.find_one
[2026-09-11T20:06:44.051Z] [ServiceBroker] Tool registered successfully: approval.get
[2026-09-11T20:06:44.051Z] [ServiceBroker] Tool registered successfully: approval.update
[2026-09-11T20:06:44.051Z] [ServiceBroker] Tool registered successfully: approval.delete
[2026-09-11T20:06:44.051Z] [ServiceBroker] Tool registered successfully: approval.count
[2026-09-11T20:06:44.051Z] [ServiceBroker] Tool registered successfully: approval.replace
[2026-09-11T20:06:44.051Z] [ServiceBroker] Tool registered successfully: approval.resolve
[2026-09-11T20:06:44.051Z] [ServiceBroker] Tool registered successfully: approval.create_many
[2026-09-11T20:06:44.051Z] [ServiceBroker] Tool registered successfully: approval.request
[2026-09-11T20:06:44.051Z] [ServiceBroker] Tool registered successfully: approval.check
[2026-09-11T20:06:44.051Z] [ServiceBroker] Tool registered successfully: approval.decide
[2026-09-11T20:06:44.072Z] [ServiceBroker] Registering module: mcp (Node: ubuntu-GW15-43P)

mesh-serve is up
  mesh      ws://127.0.0.1:4001
  cdn       http://127.0.0.1:8080
  api       http://127.0.0.1:5005
  mcp       http://127.0.0.1:5006/mcp
  mongo     mongodb://localhost:27017/test-db-111
  artifacts ./.artifacts
  config    (no .env found — using the environment only)

Ctrl-C to stop.
[2026-09-11T20:06:44.228Z] [DB] Ensured unique index "uniq_site_host" on collection "site"
[2026-09-11T20:06:44.233Z] [cdn] control site "127.0.0.1" created — 39 contract(s) for an operator
```

No site is in the system but 127.0.0.1.

Now login and resset the password and or update the email

```shell
npx mesh-serve login ... # If i dont provide --host it shold do 127.0.0.1
npx mesh-serve identity set_password
npx mesh-serve identity whoami
npx mesh-serve identity update --email [EMAIL_ADDRESS]
```

List organizations

```shell
npx mesh-serve organization find
```

List repositories

```shell
npx mesh-serve repository find
```

List sites

```shell
npx mesh-serve site find
```

Create an organization.

```shell
npx mesh-serve organization create --name platform
```

Load the repository from git repo.

```shell
npx mesh-serve repository create --name mesh-core ...
```