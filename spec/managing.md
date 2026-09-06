# Managing

The parts a developer operates this platform with — and what the platform must expose before they
can exist.

**Status: nothing built. The findings below are why this is a document and not a task.**

---

## 0. The console is not special

It is an Application, or several, published to the catalog, composed into a release, and deployed to
a hostname. **The platform manages the platform**, and that is worth insisting on for a reason
beyond neatness: a management tool built any other way is a second deployment path, and a second
path is one that stops being exercised.

It is also the honest test. Every property this system claims — parts versioned separately, one
release across hostnames, a gate per site — either holds for its own console or does not hold.

There is no bootstrap problem. The first deploy is done from the CLI, which already works: `mesh-serve
publish`, then `cdn.compose` and `cdn.deploy`. The console is simply the first thing deployed that
somebody wants to look at.

## 1. Almost nothing is exposable today — **the central finding**

Contracts default to `internal`, correctly: `defineCrud` mints ten actions per collection and
publishing all of them would be the mistake this whole design is against. But the consequence has
gone unnoticed, because until now nothing needed to *call* the platform from a browser.

| service | contracts | exposable today |
| --- | --- | --- |
| catalog | 2 | **none** |
| cdn | 3 | `resolve_site` only |
| builder | 3 | `get_artifact` only |
| api | 1 | `describe` |
| identity | 8 | 4 |

Every CRUD action on every collection is internal. So a catalog browser cannot list parts, a build
monitor cannot list builds, and a site manager cannot list sites — **not because they are refused,
but because there is no route at all.**

That is the work: deciding, per service, the smallest set a console may call. It is a design decision
about the platform's public surface, not a UI task, and it must be made before a line of UI is
written.

## 2. An operator cannot see across organizations — **and this one is a hole**

`site` is `scopedBy: 'tenantId'`, so every generated read is confined to the caller's organization.
That is right, and it is what makes an unbounded `find` safe to expose at all.

It also means **a platform operator listing every site on the platform is currently impossible.**
`resolveCallerScope` refuses a call with no scope and confines one that has it; it has no notion of a
role that sees past the boundary. An `auth: 'admin'` gate would let an admin *make the call* and
still return only their own rows.

**The answer is already designed, and it is already inert.** `schema/roles.ts` makes a role a row
with a **required** `scope: 'cluster' | 'organization'`, and says why in as many words: surfdns #26
exists because `admin` meant two different things — organization-scoped in one place, cluster-scoped
in the other — so *nobody could actually be a platform operator*. A cluster-scoped role **is** the
operator concept. `principals.ts` carries the other half: `user.roles` is documented as cluster-scoped
and held everywhere, while organization roles live on the membership as `roleKey`, "because they are a
fact about a membership".

So the design is complete and coherent. What is missing is that **`scope` is written and never read —
not once, anywhere in the repository.**

- Nothing stops an organization-scoped role key being put in `user.roles`, or a cluster-scoped one
  being used as a `membership.roleKey`. Neither write point looks at the record.
- `permits(roles, grants, contract)` takes **bare strings** and never loads the `Role` rows at all, so
  the one place that decides cannot tell the two apart even in principle.

That is #26 reproduced exactly — the same string meaning different things depending on where it is
stored — inside the file written to make it impossible. The comment is careful about this and says
only that making roles data *"removes the conditions that produced it"*. It does, and the conditions
have been rebuilt above it.

So there is no design choice to make here, only enforcement to write:

- **`permits` resolves roles to rows** and takes the caller's organization, so a cluster role grants
  everywhere and an organization role grants only within its own.
- **Both write points validate scope** against the role record, and refuse.
- **Operator contracts then need no new mechanism**: `cdn.list_all_sites` is granted to a
  cluster-scoped role, and `scopedBy` never has to learn about bypasses.

The last point is the payoff, and it is why this is worth doing before the console rather than
alongside it: a `scopedBy` bypass would have been the most security-critical flag in the system, and
a correctly-read `scope` field means it is never written.

## 3. Nothing can be streamed — **so a live console is impossible today**

Four events exist: `catalog.version_published`, `cdn.release_composed`, `cdn.site_deployed`,
`builder.artifact_published`. **None declares `scopedBy`.**

The rule is that an event which cannot be scoped is delivered to nobody, and the api refuses such a
subscription at open rather than accepting one that stays silent. So today every one of these is
unsubscribable.

Adding `scopedBy` is a one-line fix. Deciding *which field of this payload names an organization* is
not, because **not one of the four payloads carries a tenant field at all**:

| event | payload today | what it would be scoped by |
| --- | --- | --- |
| `cdn.site_deployed` | `host`, `release`, `previousRelease` | the site's `tenantId` — **must be added** |
| `cdn.release_composed` | `hash`, `kernel`, `partCount` | the release's `tenantId` — **must be added** |
| `catalog.version_published` | `partName`, `version`, `kind`, `commit` | a published version is global; `'global'` is probably right |
| `builder.artifact_published` | `digest`, `partId`, `kind`, `version` | an artifact is content-addressed and global; same |

That is the useful finding, and it is not an oversight. Every one of these was written for *another
service* to consume — the catalog listens for an artifact, and each carries exactly what that listener
needs and nothing more. A browser is a different audience asking a different question, and two of the
payloads have to grow a field before they can answer it.

The two global ones are worth typing deliberately rather than defaulting: `'global'` on
`catalog.version_published` says *anyone may watch anything published* — true, and a decision.

## 4. What the parts probably are

One Application per service, because this is a window manager and the point is having the catalog open
beside the build log. Plus the two Extensions that are not about any service.

| part | kind | what it is for |
| --- | --- | --- |
| `chrome` | extension | the shell: banner, tabs, status. Already proven once. |
| `auth` | extension | exists, published, works |
| `catalog` | application | browse parts and versions; publish |
| `builds` | application | trigger a build, watch it, read a failed build's log |
| `sites` | application | sites, releases, deploy, **rollback** |
| `identity` | application | users, organizations, memberships, revocation |

**A failed build's log is the single most valuable screen**, and it already has somewhere to come
from: the log travels on the build row precisely because *a failed build with no output is a bug
report nobody can act on*, and nothing reads it yet.

**Rollback is the second.** It is one field — `site.releaseHash` — and the console making that a
button is the difference between a design property and an operational one.

## 5. What has to be decided before any of it

In order, because each blocks the next:

1. **Which contracts a console may call**, per service. §1 — the platform's public surface.
2. **Whether an operator exists**, and if so by which of §2's three shapes.
3. **What scopes each event**, including adding a tenant to the two payloads that lack one. §3.
4. **Read-only first?** A console that can deploy can take a site down. Every screen listed above is
   useful read-only, and the write half — publish, build, deploy, rollback — is a separate decision
   per action. Shipping read-only first is not timidity; it is the half that cannot break anything,
   and it is most of the value.

## 6. What this is not

**Not a replacement for the CLI.** Genesis, recovery, and anything done when the platform is unwell
belong on the command line — a console that manages the platform cannot be the only way to fix the
platform, for the same reason `src/fleet/` may not import another service here.

**Not per-tenant application hosting.** This is the *operator's* view of the machinery. What a
tenant's own users see is their product's business.
