# Company knowledge platform: handoff

Written 2026-09-13 for whoever picks this up next, human or agent. It assumes
you have read nothing else. Read `.fork/agent-policy.md` before you write
anything; this document does not restate it.

The platform was designed, built, integrated and connected to Carbon over three
days by many parallel agents. Almost everything is written. Almost nothing has
run in production. The gap between those two sentences is the whole job that
remains, and most of this document exists to stop you from misjudging it.

---

## 1. What the product is

A company knowledge portal. A person opens a web page, asks a question in plain
language, and gets either a direct link to the exact document or record that
answers it, or a short written answer that cites its sources and abstains when
the evidence does not support one. Answers are filtered by that person's own
permissions, and access removed in Carbon stops working within seconds.

Its corpus is of two kinds. Documents people upload, extract and review, such as
equipment manuals. And live records read from business systems: items, receipts,
purchase orders and supplier pricing from Carbon, boards and tickets from the
Kanban application in the sibling `../kanban` repository.

The scenario it was designed around, and the one to protect in any refactor, is
"which manual applies to the part we just received". It resolves in three hops:
recent receipts, the items behind those receipt lines, then the manuals
applicable to those items at that revision on that date.

### The shape of it

Five deployable services, plus Carbon and Kanban which are sources, not parts:

| Service | Does |
| --- | --- |
| `apps/knowledge` | the portal web application people use |
| `apps/knowledge-query` | reads: retrieval, routing, synthesis, source calls |
| `apps/knowledge-worker` | ingestion, indexing, Drive sync, retention, recovery |
| `apps/knowledge-actions` | writes: ticket commands, procurement drafts |
| `packages/knowledge` | the shared contracts, identity, sources, cache |

The knowledge data lives in its own schema with its own roles. Carbon's database
holds only one knowledge object, an outbox table, and that table's triggers are
currently switched off deliberately.

### Two rules that explain most design decisions

**The platform never reads Carbon's tables.** It calls Carbon's canonical API as
an authorized workforce caller, and Carbon answers under the requesting
employee's own permissions. If you find yourself writing a query against
Carbon's tables from a knowledge service, you have taken a wrong turn.

**Admission is not assurance.** Getting through the sign-in gate proves who
someone is, never what they are allowed to do or how strongly they authenticated.
Every authority decision is made again, against Carbon, on every request.

---

## 2. Repository mechanics you must know

This is a long-lived public fork of `crbnos/carbon`.

- **The trunk is `saturn/main`.** The `main` branch is a stale mirror of
  upstream. Branch from and target `saturn/main`.
- **Branch protection is on and applies to admins.** Six checks are required and
  branches must be up to date before merging, so an open pull request goes stale
  whenever the trunk moves. That is expected, not a problem.
- **Upstream is merged in on a schedule.** Long-lived branches rot. Land work or
  expect conflicts.
- **Generated files use a `regen` merge driver** that takes the incoming side
  wholesale. That is correct for a single merge and wrong for a union of
  branches: it has already silently dropped a column that another branch added.
  After any multi-branch merge, regenerate with `scripts/fork/regenerate.sh
  --fresh` and confirm a second pass leaves the tree clean. Never hand-merge a
  generated file.
- **Everything tracked is public.** No customer data, credentials, internal
  domains, project identifiers or tailnet details, in code, tests, fixtures,
  commit messages or pull request bodies. Local deployment inputs belong in the
  ignored local configuration directory.

### Records

Durable outcomes go in `.fork/decisions/`, one per change; lessons in
`.fork/lessons/` as Context, Problem, Rule, Applies-to; plans in `.fork/plans/`;
disposable run output in the ignored `.fork/local/`. There are forty lessons and
roughly thirty decision records for this platform alone. **Read the decision
record for any component before you change it.** They exist because the
reasoning is usually not recoverable from the code.

---

## 3. Where things stand

### Merged to the trunk

The whole platform, as one integrated branch of thirty-three pull requests, all
continuous integration green. Then a migration that switches the outbox triggers
off, and the program index.

### Open and verified, waiting to merge

One draft integration branch carrying nine repairs found when the platform was
first connected to a real Carbon instance. All fifteen checks pass on it. Merge
it as one set rather than nine times; two of the nine fail together and pass
apart, which is exactly why it exists.

### Never run anywhere

The cloud. No identity-aware proxy, no Google sign-in, no managed service
identities, no infrastructure applied. The portal has never been deployed. This
is the single largest block of unproven behaviour and it is one task, the only
one in the program with no code written, because it needs a real project and
real credentials.

### Deliberately switched off

Google Drive, typed and spoken commands, procurement drafts, the machine
interface for other tools, and written answers. All five are finished. The
release profile excludes them, the route manifests omit them at build time, and
the release planner refuses their configuration keys. Enabling any of them is a
decision for the operator, not a code change you should make on your own
judgement.

---

## 4. The security model, which is the part worth protecting

Treat this as the most valuable asset in the program. It was tested
adversarially against a real Carbon instance and held: thirteen attacks, all
refused correctly, including forged actor headers, a service token minted for
another audience, evidence from another application, an unregistered service
account, a user claiming another company, a capability not granted, and a
permission removed in Carbon mid-session.

Its parts, and what each is for:

**Two assertions, not one.** Every call from the platform to Carbon carries both
a service identity token, proving which service is calling, and user evidence,
proving which person it is acting for. Neither alone is sufficient.

**Identity is bound, never inferred.** A person's Google account number is
linked to a Carbon user by an explicit enrollment step performed by an
administrator. Never by email, never by domain, never automatically. Emails are
renamed and reused; account numbers are not.

**Revocation is irreversible by design.** Deactivating a Carbon user, or
removing their company membership, immediately marks every matching binding
inactive. Reactivating the user does not restore it. Someone must enroll them
again. A test that restores a user and expects access to return is testing the
wrong thing, and one such test was written and later corrected.

**Assurance is separate from admission.** Carbon can require multi-factor
authentication. The platform cannot see whether a portal session used it,
because the person authenticated to Google rather than to Carbon. There are two
modes: one requiring Carbon's own factor, which always denies because no session
evidence is forwarded, and one where the operator documents that Workspace
two-step verification plus a named access level is equivalent. This deployment
uses the second. Two-step verification is enforced organization-wide, so every
successful sign-in has necessarily used it.

**Every operation is on an allowlist, twice.** Carbon publishes a fixed set of
knowledge operations, each with a capability and a permission. The transport
keeps its own allowlist so that retrieved content cannot induce an unexpected
call. Those two lists drifted apart silently once; a test now fails whenever an
operation is published but neither registered nor explicitly excluded with a
reason.

**Refusals are opaque and uniform.** A denial must never reveal whether the
thing exists. Distinguish the class of failure, never the reason.

If you change any of this, expect to justify it. Nothing in this area should be
changed to make a test pass.

---

## 5. Running it

### The portal alone

A containerised stack brings up the portal, its services, a database, Redis and
storage. Its project name, image tag and every published port are configurable,
so several can run side by side; leave the defaults alone and you will collide
with whatever is already running. There is no login screen: identity is a cookie
naming a fixture user, and the gate's signature is replaced by a local one. Only
Google's signature check is synthetic. Audience, issuer, freshness and access
levels all run through the production code.

### Connected to Carbon

This has been done once, on a disposable Carbon database seeded with a demo
dataset. It needs four things: Carbon configured as a receiver with a trusted
caller registry, an enrolled identity, the query service told the ERP exists,
and the knowledge schema co-located in Carbon's database, because Carbon's
identity resolution function reads the knowledge binding table directly.

That last point matters and is easy to miss: **the shipped local stack uses a
separate database with synthetic company and user tables, which is not the
arrangement a deployment needs.** That divergence hid a defect that made
enrollment impossible against any real Carbon database. If you are verifying
anything about identity, verify it in the co-located arrangement.

### Never touch

The developer's own Carbon stack, database or volumes. Never reset it, never
rebuild it to test something, never apply migrations to it without being asked.
Use a disposable slot with a unique name and remove it afterwards. Other stacks
belonging to other work are frequently running; do not stop, reuse or retag
anything you did not create.

---

## 6. How to verify, and how verification lies

This program produced a long list of things that passed while being wrong. The
pattern is consistent enough to state as a rule: **every time someone looked
harder, they found something real.** Assume that is still true.

**Unit tests passed while the feature could not run.** A browser test for the
Drive connector had four independent reasons it could never have passed, found
only when someone finally ran it. A command test asserted a refusal that the
release fence made impossible to produce.

**A test fixture hid a production defect.** The test database substituted a
simpler identifier function needing no privileges, so a missing grant that made
enrollment impossible passed every suite. Removing the grant changed nothing
until the fixture was made real; then five tests failed with the production
error.

**A green suite proved the mechanism, not the deployment.** Integration tests
provisioned the triggers they were testing. That is legitimate, but it means
they prove the function works, not that the shipped schema has it enabled.

**Flaky is a diagnosis, not a description.** A browser suite failing at a
different assertion each run was traced to one cause: the hydration check was a
false positive, because a server-rendered script sets the flag it waited on even
when the client bundle never loads.

**Branches that pass alone fail together.** Repeatedly. A dropped schema column,
a mock missing an export that a second branch started using, a fixture that left
shared state broken for the next suite. Never merge a set of branches without
verifying the union.

**Using it beats testing it.** Twenty minutes of driving the portal by hand
found two defects that every automated suite missed. The first connection to a
real Carbon instance found eleven.

Practical consequences: run the containerised browser suite several times cold,
not once; prove a fix by reverting it and watching the test fail; and when a
command's output looks green, check that it actually ran the thing you think it
did, because several suites skip silently without a database.

---

## 7. What remains

In the order I would do it.

1. **Merge the open integration branch.** Verified, green, nine repairs.
2. **Run the platform against a real Carbon instance with real documents, for
   weeks, not hours.** This has found something every single time it has been
   done. It needs no cloud and risks nothing.
3. **Deploy the cloud identity foundation, read-only, with one user.** Apply the
   infrastructure, put the gate in front of the portal, require the access
   level, sign in once. Then confirm the requirement is actually enforced rather
   than merely configured, which is the one check most likely to be skipped.
4. **A small pilot, still read-only.** Watch the alerting and the spending
   limits, which have never seen real traffic and whose thresholds are guesses.
5. **Then, one at a time and only when the core is trusted**, consider the
   deferred features.

### Known open items

- The receiver's token verification can only fetch Google's live keys. There is
  no seam for a local key set, so the Carbon half cannot be exercised outside a
  real cloud without patching it from outside. Any such seam must be chosen when
  the image is built and impossible to enable in a release, or it is an
  authentication bypass.
- A blanket catch in the verifier turns any failure during identity resolution
  into an identity denial, so a step-up requirement raised there is
  indistinguishable from an unknown caller.
- A reversed-quantity field in the receipt read has never been reachable and
  always returns zero.
- The recovery drill has never run: restore into an isolated environment and
  prove denied documents stay denied.
- Sending a bearer token that is not an API key to the versioned API now selects
  the workforce branch and returns service-unavailable rather than unauthorized,
  which is retryable and invites retry storms.
- Retrieval quality was measured on a synthetic corpus of two thousand chunks.
  Nothing is known about real documents.

---

## 8. If you read only one thing

The security model is good and was proven adversarially. The product's plumbing
was written faster than it was exercised, and every new form of scrutiny has
found real defects. So: do not add features. Run what exists, against real data,
and fix what that turns up. The most valuable contribution available right now
is not code.
