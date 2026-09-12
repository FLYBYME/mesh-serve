# The CLI

**The terminal is a client of the API, and of nothing else.**

> *"everything that the package mesh-serve provides must be managed though the api and the cli. this
> is a must now. nothing else. no writting a nodejs script to connect to the mongodb."*

That is the whole design. Every rule below follows from it.

**None of this is built.** `src/cli` existed and the shipped CLI did not use it, which is §1's
argument rather than a plan to fix.

---

## 1. It is generated, not written

The API already describes itself: every contract carries a domain, an action, a description, an input
schema with types, defaults, minimums and maximums, an output schema, a `destructive` flag and its
declared errors. [serving.md](./serving.md) §8.

**A hand-written command is a second declaration of something already declared**, and it will drift.
The evidence is in this repository: `src/cli` existed, and the shipped CLI did not use it.

So the shape is uniform and derived:

```
mesh-serve [--host H] <noun> <action> [--field value ...]
```

| the sketch | the contract |
| --- | --- |
| `mesh-serve organization find` | `organization.find` |
| `mesh-serve organization create --name platform` | `organization.create` |
| `mesh-serve repository find` | `repository.find` |
| `mesh-serve repository create --name mesh-core --url …` | `repository.create` |
| `mesh-serve site find` | `site.find` |
| `mesh-serve identity whoami` | `identity.whoami` |
| `mesh-serve identity set_password` | `identity.set_password` |

**Flags come from the input schema.** `--name` exists because the schema has `name`. Its type, its
default, whether it is required, and its description all come from the same place, so `--help` is
generated and cannot be stale.

Three commands are not contracts, because they are about the terminal rather than about the platform:
`login`, `logout` and `use` (choosing a host or an organization). Everything else is a contract.

---

## 2. `login`

```
mesh-serve login                     # --host defaults to 127.0.0.1
mesh-serve --host example.com login
```

**The default host is `127.0.0.1`**, because the control site is the one that exists on a machine that
has just started, and typing the flag every time to reach the only site there is is friction with no
purpose.

### It must print what it did

> *"`login` succeeds and prints nothing."*

The ticket was written and the confirmation was swallowed. **A command that changes state on disk and
says nothing is indistinguishable from one that failed silently**, and the person then runs it again.

What it prints is the answer from [identity.md](./identity.md) §7: who you are, and the complete list
of what this account can do, with scope as a column.

```
signed in as  tim@example.com  on 127.0.0.1

  identity.user.find                          everywhere
  serve.part.create        in   Platform
  serve.part.find          in   Platform, Flowboard Inc
  serve.site.seed          in   Platform
```

**That list is the point of logging in from a terminal.** A caller reads it and knows what to try,
without a second call and without guessing.

---

## 3. First boot

A cluster with no accounts cannot be signed into, so identity creates one and prints it once:

```
────────────────────────────────────────────────────────────────────────
  FIRST BOOT — no accounts existed, so one was created.

    email     operator@node.invalid
    password  JXkMDtM4r22QiupkHljA0nQrospzIKvZ

  This is shown once and is not recoverable. It can do nothing except set its own
  password — every other call is refused until it does.

    mesh-serve --host <site> login
────────────────────────────────────────────────────────────────────────
```

**Three things about that banner are requirements, not presentation.**

1. **It says the credential can do nothing else.** A provisional account is refused everywhere except
   `identity.set_password`, and a person who does not know that reads the next refusal as a bug.
2. **It says what to run next.** The one thing a first-boot message must not do is leave somebody at a
   prompt with a password and no verb.
3. **It is not recoverable.** So it must not be buried. A banner that scrolls past under fifty lines of
   broker registration has not been shown — and that is what happened, because service registration
   logs one line per tool. How it survives the log stream is **E6**.

---

## 4. Passwords

**A password is never read from argv.** It is visible in `ps` to every user on the machine and it lands
in shell history.

| | |
| --- | --- |
| `login` | prompts, with echo off |
| `set_password` | prompts twice, and confirms they match before sending |
| `account reset-password --old` | prompts for both. The flag says *I know the old one*, it does not carry it |
| a non-interactive environment | reads from an environment variable, named in the error when there is no tty |

**Minimum twelve characters**, checked by the contract's own input schema so the API and the CLI agree
by construction.

---

## 5. Output

**Two modes, and the default is for a person.**

- **A table for a person**, from the output schema. Column order from the schema, values formatted by
  type, and a contract's own `print` function used when it has one.
- **`--json` for a program**, which is the parsed output and nothing else on stdout.

Everything else — progress, warnings, the banner — goes to **stderr**, so `| jq` works without a flag.

**A refusal prints its sentence, not its status.** The wire carries a code and a message
([errors.md](./errors.md)); the terminal shows the message and exits non-zero. *"Request failed with
status code 403"* is the failure mode this rule exists to prevent.

---

## 6. Destructive calls

A contract declares `destructive`. **The CLI asks before running one**, naming what it is about to do,
and `--yes` skips the prompt.

This is the same declaration a UI uses to decide whether to confirm, and the same one that means an
agent's call may need an approval. **One flag on the contract, three readers** — which is the shape
rule 5 in [README.md](./README.md) asks for, and one of the few places this repository already had it
right.

---

## 7. What must be true

- **The CLI holds no knowledge the API does not have.** If the terminal can do something the API
  cannot, that is a missing contract and not a CLI feature.
- **It never opens the database.** Not for a fix, not for a migration, not once.
- **It stores a ticket, not a password**, in a file only the user can read, per host.
- **A command that changes something says what changed.** §2.
- **`--host` and the stored ticket travel together.** A ticket is for one host, and using one against
  another is a silent wrong answer.
