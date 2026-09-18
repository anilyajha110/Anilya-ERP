# Anilya ERP — Phase 1: Production Engineering Foundation

Status: **Phase 1 in progress.** This is the foundation layer only — a
real TypeScript monorepo, a real PostgreSQL migration system, a real
tested API skeleton with health/readiness endpoints. **No business
modules (Orders, Identity, Artwork, etc.) exist yet** — those are
Phase 2+, scoped and sequenced in `docs/PHASE_0_AUDIT_REPORT.md`.

Every command below was actually run against a real PostgreSQL 16
instance during this build — not assumed to work.

## Prerequisites
- Node.js 22+
- PostgreSQL 16 (locally, or via the included `docker-compose.yml` if you have Docker)

## Setup

```bash
# 1. Install dependencies (real npm workspaces monorepo)
npm install

# 2. Start Postgres (pick one)
docker compose up -d postgres        # if you have Docker
# — or point PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE at your own local Postgres —

# 3. Copy and adjust environment config
cp .env.example .env

# 4. Apply database migrations
npm run db:migrate

# 5. Run the full verification gate (what CI runs)
npm run verify
```

`npm run verify` runs, in order: typecheck → lint → db:migrate → test → build.
This is the exact sequence `.github/workflows/ci.yml` runs on every PR.

## Running the API locally

```bash
npm run dev --workspace=apps/api
# GET http://localhost:3000/health  → { "status": "ok" }
# GET http://localhost:3000/ready   → { "status": "ready", "database": "connected" }
```

## Repository layout (Phase 1 slice)

```
apps/api/              TypeScript API — config validation, structured logging,
                        correlation IDs, health/readiness endpoints
packages/database/      Migration runner (up/down, transactional, idempotent) +
                        migrations/ (.up.sql / .down.sql pairs)
.github/workflows/ci.yml   The real CI quality gate
docker-compose.yml      Local Postgres + Redis for development
docs/                   Phase 0 audit deliverables (requirement register,
                        risk register, workflow catalog, ADRs, etc.)
```

`packages/contracts`, `packages/test-kit`, and `apps/worker` are
intentionally **not** scaffolded yet — they need real business schemas
and real domain fixtures to be meaningful, which don't exist until
Phase 2. Empty placeholder folders were removed rather than left as
ghost directories.

## What's genuinely verified vs. not

| Claim | Verified how |
|---|---|
| Migrations apply, are idempotent, and roll back cleanly | `packages/database/src/migrate.test.ts` — runs the actual CLI against a real Postgres instance |
| `/health` and `/ready` behave correctly, including the failure case | `apps/api/src/server.test.ts` — 5 tests, including one that deletes the health-check row and confirms a real 503 |
| TypeScript compiles with zero errors across every workspace | `npm run typecheck` |
| No dependency vulnerabilities | `npm audit` — a critical/high finding was caught and fixed (vitest major-version upgrade) during this build, re-verified after upgrading |
| Docker Compose file is syntactically what Postgres/Redis images expect | **Not verified** — Docker isn't available in the environment this was built in. Review before first real use. |
| GitHub Actions workflow runs green on a real PR | **Not verified** — needs a real GitHub repository connected to Actions; the workflow steps mirror `npm run verify` exactly, which *is* verified, but the YAML itself has not been executed by a real runner. |

## Getting this into your own GitHub repository

I don't have credentials to push to your GitHub account, so this is a
manual step (see the earlier chat message for why). From inside the
extracted `anilya-erp/` folder:

```bash
# 1. Create an empty repository on GitHub first (no README/license —
#    this project already has its own), then:
git remote add origin https://github.com/<your-username>/<your-repo>.git
git branch -M main
git push -u origin main
```

The `.git` history (2 commits: initial Phase 1 foundation, then a
lockfile regeneration after a clean-reinstall verification) is already
included in this zip, so `git log` on your end will show the real
build history, not a single squashed dump.

## Phase 2 — Identity, RBAC, and Unified Audit (done)

Organizations, a unified `identities` table (one shape for Staff/
Partner/Customer instead of the prototype's three inconsistent ones),
relational RBAC, hashed sessions, centralized OTP, and ONE audit log —
made genuinely immutable by a Postgres trigger, not by "no code path
happens to touch it."

**The one rule most worth knowing:** `requireAuth`/`requirePermission`
(`apps/api/src/modules/identity/rbac.ts`) derive who's making a request
**only** from a verified session token. Nothing anywhere accepts a role
or identity claim from the request body — this is the direct fix for
the prototype's most serious finding (RISK-003), and there's a
dedicated test (`identity.test.ts`) that sends a fake `actorRole` claim
with no valid session and confirms it's fully ignored (401).

### New endpoints
| Method | Path | Purpose |
|---|---|---|
| POST | /api/identities/register | Create an identity (Staff/Partner/Customer) within an organization |
| POST | /api/identities/login | Password login → session token |
| POST | /api/identities/logout | Revokes the session |
| GET | /api/identities/me | Returns the identity the SERVER believes is authenticated — proof the session-derivation works |

### Verified live (21 tests total now pass, all against real Postgres)
- Same email allowed in two different organizations; rejected as a duplicate within the same one (multi-tenant isolation, genuinely tested)
- `UPDATE`/`DELETE` against `audit_log` both fail with a database-level error — tried directly via `psql`, not just "no route exists"
- A permission-gated test route: identity without the permission → 403; with it → 200
- The exact RISK-003 attack pattern (claiming `actorRole: "Super Admin"` in the body, no real session) → 401
- Logout immediately invalidates the same token
- **A genuine regression was found and fixed during this phase**: an existing Phase 1 test asserted the `down` migration always reverses `app_health` specifically — true only when that was the *latest* migration. Adding migrations 0002–0007 broke that assumption; the test now checks whichever migration is actually most recent instead of a hardcoded name.

### Still not done (by design — later phases)
- No UI for any of this yet (Phase 2 is the API + data layer only)
- Default roles/permissions are not seeded yet — you create them yourself in each organization for now
- The Customer/Partner OTP login flow (as opposed to Staff password login) isn't wired to a route yet — the `otp_requests`/`otp_channel_deliveries` tables and hashing exist, but no `/login/otp` endpoint calls them yet
- File-access control (the prototype's other SECURITY BLOCKER) is not part of Identity — it'll be addressed when the Files module is built

## Phase 3 — Customer/CRM (done)

Customer profiles (extending Identity's `customer` type with the
structured billing chain), an append-only ledger with the running-
balance math enforced by a real database CHECK constraint, and a full
import preview/commit/rollback system — directly closing a gap the
Phase 0 audit flagged as missing entirely in the prototype (CRM-004:
no preview, no dry-run, no safe rollback).

### New endpoints
| Method | Path | Purpose |
|---|---|---|
| POST | /api/customers | Staff: find-or-create by phone→email→dummy (CRM-001) |
| GET | /api/customers/:id | Staff: view a customer's profile + billing |
| PATCH | /api/customers/:id/billing | Staff: update the GSTIN/address chain (CRM-002) |
| GET | /api/customers/:id/ledger | Staff: full ledger + running balance |
| POST | /api/customers/:id/ledger/adjustment | Staff: the only sanctioned correction — a new row, never an edit |
| POST | /api/customers/import/preview | Staff: see what an import WOULD do, writes nothing |
| POST | /api/customers/import/commit | Staff: actually run it, tracked as a batch |
| POST | /api/customers/import/:batchId/rollback | Staff: undo — deletes only what THIS batch created |
| GET | /api/customers/me | Customer: their own profile, derived only from their session |
| GET | /api/customers/me/ledger | Customer: their own ledger, same rule |

### Three genuine bugs found and fixed this phase
1. **Route-ordering bug** (same class as one already fixed in the
   Inventory module during the original prototype build): `/customers/:id`
   was registered before `/customers/me`, so Express matched "me" as an
   `:id` value and ran the wrong permission check entirely. Fixed by
   reordering — the specific route must come before the parameterized one.
2. **Rollback crashed on a real foreign-key violation**: deleting a
   customer an import batch had created failed because
   `import_batch_entries` still pointed at it. Fixed the foreign key to
   `ON DELETE SET NULL` — the audit record of what happened survives,
   only the now-dangling reference clears.
3. **A self-registered customer had no profile row at all**: the
   CRM module's own `findOrCreateCustomer` correctly created a
   `customer_profiles` row alongside the identity, but a customer
   signing up through Identity's generic `/identities/register`
   endpoint didn't get one — `/customers/me` returned null forever, a
   real production bug had this shipped as-is. Fixed with a small hook
   Identity exposes (`onIdentityCreated`) that CRM wires up, so Identity
   stays generic (it still has no idea what a `customer_profiles` row
   is) while every customer, however they're created, ends up correctly
   set up.

### Verified live (33 tests total now pass, all against real Postgres, from a genuinely fresh `node_modules` + database)
- Phone match takes priority over email; a customer found by either
  is never duplicated
- A customer with neither phone nor email is created as `dummy`, not silently rejected
- Concurrent-safe ledger posting (`SELECT ... FOR UPDATE` row lock — two
  simultaneous postings can't both read the same stale "previous
  balance")
- Import preview writes nothing — running it twice shows identical results
- Import commit correctly separates newly-created customers from matched existing ones in the same batch
- Rollback removes only what the batch itself created — a customer
  that already existed before the import is never touched, verified directly
- Rolling back the same batch twice is rejected (409), not silently repeated
- A staff identity without `customers.write` cannot create a customer (403)
- A customer sees exactly their own profile via `/me` — never another
  customer's, and there's no `:id` in that URL to manipulate in the
  first place
- A staff identity is correctly rejected (403) from the customer-only self-service routes

## Phase 4 — Booking/Orders (done)

The core order entity — scoped deliberately to Booking/Orders alone.
Artwork, Production, and Logistics each get their own later phase and
will extend the order lifecycle with their own stages, rather than
this phase trying to anticipate all of them up front.

### New endpoints
| Method | Path | Purpose |
|---|---|---|
| POST | /api/orders/import | Staff: idempotent order creation |
| GET | /api/orders/:id | Staff: view an order |
| POST | /api/orders/:id/:action | Staff: `confirm`/`start`/`complete`/`cancel` |
| GET | /api/orders/me | Customer: their own orders, session-derived |
| GET | /track/:token | **Public, no login** — the shareable tracking link |

### The two things that mattered most this phase
1. **Real idempotency** (fixes RISK-007 — the prototype's import was a
   direct-write endpoint with no real retry contract). `idempotencyKey`
   is a genuine, DB-enforced unique constraint per organization:
   replaying the exact same import call — a webhook retry, a doubled
   click — returns the SAME order every time, never creates a second
   one. Verified live: the same key submitted twice produces one row in
   the database, not two, and the second call returns 200 (not 201) with
   the identical order id.
2. **The public tracking link never leaks phone or email** (ORD-005).
   `publicTrackingView()` doesn't select those columns into the response
   shape at all — there's no field to accidentally forget to redact.
   Verified live: an order created with a real phone number, then
   tracked publicly, has that number nowhere in the response body,
   confirmed by asserting the number's exact digits don't appear
   anywhere in the JSON.

### Learned from Phase 3, applied from the start this time
The exact same routing-order mistake (`/orders/:id` swallowing a
specific path) was avoided by registering `/orders/import` and
`/orders/me` before the parameterized route, from the first draft —
not found and fixed after the fact. **Zero bugs were found in this
phase's own test run** — a good sign the earlier phases' lessons are
compounding rather than repeating.

### Verified live (44 tests total now pass, all against real Postgres, from a genuinely fresh `node_modules` + database)
- Display order numbers (`ANILYA/2026/09/00001` format) never collide under back-to-back imports
- A valid transition (`confirm`) succeeds and the audit log captures
  the exact old→new stage
- Completing an order that was never started is rejected (409), not
  silently applied
- Cancelling with no reason is rejected (400)
- A completed order can never be cancelled — the state machine enforces this, not just UI discipline
- Tracking a nonexistent token returns 404, not a leaked stack trace
- A customer's `/orders/me` shows only orders actually linked to
  their own identity — an order for a different customer by that name
  doesn't appear
- A staff identity without `orders.import` is rejected (403)

## Phase 5 — Artwork Management (done)

The single most safety-critical rule in the entire project (ADR 0002),
now genuinely enforced by code and proven by tests that reproduce both
historical failure modes exactly, not just asserted as a comment.

### New endpoints
| Method | Path | Purpose |
|---|---|---|
| GET | /api/orders/:id/artwork/status | Current AMS stage, print-ready flag |
| GET | /api/orders/:id/artwork/versions | Full 4-stage file history |
| POST | /api/orders/:id/artwork/customer-upload | Stage 1 |
| POST | /api/orders/:id/artwork/customer-approved | Stage 2 — locked reference only, never print-ready |
| POST | /api/orders/:id/artwork/print-reviewed | Stage 3 — Operator's technical check |
| POST | /api/orders/:id/artwork/print-approved | Stage 4 — **the only action that can ever set print-ready**, its own separate permission |

### The rule itself (ADR 0002), and how it's actually enforced
`order_artwork.print_ready` starts `false` and is set `true` in exactly
one place in the entire codebase (`submitPrintApproval` in
`artwork.service.ts`). `transitionOrder`'s `start` action (Phase 4)
checks this flag before allowing an order into production — customer
approval alone (`customer_approved_ref`) is stored only as a locked
historical reference; nothing anywhere reads it to make that decision.

Two regression tests reproduce the exact historical failure modes from
the prototype's own history, not hypothetical ones:
- **An order that only has customer approval** attempts to start
  production → rejected (409), the exact bug an earlier prototype
  version actually had before the internal-approval gate was added.
- **A `blank`-intent order** (artwork never required at all) starts
  production with zero AMS interaction → succeeds — the exact inverse
  bug the print-ready gate itself introduced once, by blocking orders
  that never needed a file in the first place.

### A real bug found by the verify pipeline itself (not the tests)
`npm run test` was silently running every test **twice** — once from
`src/*.test.ts`, once from `dist/*.test.js` after a build, since
neither workspace had a vitest config telling it to ignore compiled
output. Not a correctness bug (both copies always agreed), but wrong
and wasteful, and would have masked a real source/build divergence if
one ever appeared. Fixed with a two-line `vitest.config.ts` in each
workspace; verified by explicitly building first and then running
tests against an already-populated `dist/`, confirming exactly 49
tests run once, not 98.

### Verified live (49 tests total now pass, all against real Postgres, from a genuinely fresh `node_modules` + database)
- Full 4-stage flow (upload → customer-approved → print-reviewed →
  print-approved) genuinely makes `print_ready = true` and clears
  `ams_stage`, and only then does `start` succeed
- `print-approved` attempted before any `print-reviewed` version exists
  → rejected (409) — Stage 3 must happen before Stage 4
- Version history returns all 4 stages in the correct order, each a
  genuinely separate, immutable row
- `'no'`-intent orders start at `artwork_creator`; `'attachment'`-intent
  orders start at `artwork_verifier` — the right stage for the right
  scenario, decided once at import
- Ordinary staff (`orders.write` but not the separate
  `orders.artwork.approve` permission) cannot give final print
  approval (403) — the single most consequential action in this module
  has its own, narrower permission, not bundled into general write access

## Phase 6 — Gang Run (done)

Combining multiple orders' printing into one shared physical run —
scoped to just the pooling mechanism and its one non-negotiable rule.
A full Job/Production engine (job lifecycle, escalation, vendor rates)
is deliberately left for its own later phase.

### New endpoints
| Method | Path | Purpose |
|---|---|---|
| POST | /api/gang-runs | Create an open Gang Run |
| GET | /api/gang-runs/:id | View one |
| GET | /api/gang-runs/:id/members | List pooled orders |
| POST | /api/gang-runs/:id/members | Add an order — **the print-ready check happens here** |
| POST | /api/gang-runs/:id/complete | Close it — members are never deleted |

### The one rule that matters (ART-004/ART-005)
An order may join a Gang Run **only** if Phase 5 already marked it
individually print-ready. Gang Run combination is a third tier layered
on top of that approval, never a substitute for it — enforced in
exactly one function (`addOrderToGangRun`), so every write path funnels
through the same check. Verified live, both directions: a non-print-
ready order is rejected (409, naming the reason); a genuinely print-
ready one succeeds. An order already pooled once can't join a second
Gang Run, and completing a Gang Run never deletes its member history —
the "Shadow ID" closes, but ART-005's audit trail stays fully queryable.

### Verified live (59 tests total now pass, all against real Postgres, from a genuinely fresh `node_modules` + database)
- An order with zero artwork approval cannot be pooled (409, "print-ready" named in the error)
- A fully print-ready order can be pooled
- Multiple print-ready orders can be pooled into the same run
- An order already in one Gang Run is rejected from a second (409)
- A completed Gang Run refuses new members (409) — its member list is frozen, not deleted
- Member history survives after completion, fully queryable
- A staff identity without `gangrun.manage` cannot create one (403)

## Phase 7 — Job / Production Engine (done)

The core unit of production work against an order — job lifecycle,
escalation, and the two rules with real teeth (JOB-002, JOB-004).
Vendor rate approval (JOB-005/006) and the Artwork Operator payment
ledger (JOB-007) are deliberately deferred to their own later phase —
same discipline as splitting Gang Run out of "Production" in Phase 6.

### New endpoints
| Method | Path | Purpose |
|---|---|---|
| POST | /api/orders/:orderId/jobs | Create a job on an order |
| GET | /api/orders/:orderId/jobs | List an order's jobs |
| GET | /api/jobs/:id | View one job |
| POST | /api/jobs/:id/assign | Assign to a Partner — **JOB-004 checked here** |
| POST | /api/jobs/:id/start / /complete | Job lifecycle |
| POST | /api/jobs/:id/escalate | Raise one of 5 named triggers |
| POST | /api/jobs/:id/escalate/resolve | Manager-only, its own permission |
| GET | /api/escalations | The open queue |

### The two rules that matter, both verified in both directions
- **JOB-004**: a Partner who has never logged in cannot receive a
  direct job assignment. Checked live against `sessions` (Phase 2),
  never a stored flag that could drift stale — a Partner's actual login
  history is always the current truth. Verified live: a never-logged-in
  Partner rejected (409, naming the reason); a genuinely logged-in one
  succeeds.
- **JOB-002**: an order cannot complete while any of its own jobs are
  still open. Wired into `transitionOrder`'s existing `complete` action
  (the same function Phase 5's print-ready gate uses) — the error names
  exactly which job(s) are still blocking, not just a bare refusal.
  Verified live: an order with one incomplete job rejected (409,
  naming it by description); the same order, once that job completes,
  succeeds. An order with **no jobs at all** completes freely — the
  gate only blocks on jobs that actually exist.

### A real cross-router bug found live, not assumed away
`POST /orders/:orderId/jobs` was silently being swallowed by the
Orders router's own generic `/orders/:id/:action` route — Express
matches across separately-mounted routers in **mount order**, not just
within one router, and Orders was mounted first, so it greedily
matched `.../jobs` as `:action = "jobs"` before the Jobs router ever
got a chance. The exact same class of bug already found once within a
single router (`/customers/me` vs `/customers/:id`, Phase 3) —
this time it crossed a module boundary, a genuinely new variant.
Fixed by mounting the Jobs router before the Orders router.

### Verified live (70 tests total now pass, all against real Postgres, from a genuinely fresh `node_modules` + database)
- Full job lifecycle: open → assigned → in_progress → completed
- Starting a job that was never assigned is rejected (409)
- A job can't be escalated twice while the first escalation is still open (409)
- Resolving an escalation removes it from the open queue immediately
- Ordinary staff (`jobs.manage` but not the separate
  `jobs.escalations.manage`) cannot resolve an escalation (403) — the
  same "narrower permission for the more consequential action" pattern
  as Phase 5's print-approval

## Phase 8 — Vendor Rates & Operator Payment Ledger (done)

The two pieces deliberately deferred out of Phase 7 to keep the core
job engine focused: rate quote approval, and the Artwork Operator
payment ledger.

### New endpoints
| Method | Path | Purpose |
|---|---|---|
| PUT | /api/vendor-rates/:category | Set the master reference rate — its own permission |
| GET | /api/vendor-rates/:category | View it |
| POST | /api/vendor-rates/quotes | A Partner submits a quote on a job |
| GET | /api/vendor-rates/quotes/pending | The Manager approval queue |
| POST | /api/vendor-rates/quotes/:id/approve / /reject | Manager-only decision |
| POST | /api/operators/:id/ledger/payable | Record what AMS reports owed — idempotent on `externalReference` |
| POST | /api/operators/:id/ledger/payment | Record an actual payout |
| GET | /api/operators/:id/ledger | Full ledger + running balance |

### The two rules that matter, both verified in both directions
- **JOB-005/006**: a quote at or under the reference rate is
  auto-accepted, no Manager involved at all; above it, it waits for
  approval. **Approving a quote never moves the master rate itself** —
  verified live by approving a quote at 5× the reference rate, then
  confirming the master rate afterward is still exactly what it was
  before. The rate compared against is snapshotted onto the quote at
  submission time, so a later master-rate change never retroactively
  changes what an already-decided quote's own record means.
- **JOB-007**: the ERP does zero rate math on the Operator side — it
  only ever records the exact final amount an external system (AMS)
  reports. `externalReference` (AMS's own WORK_ID) is a genuine
  idempotency key, the same principle as Orders' `idempotencyKey`
  (Phase 4): replaying the same WORK_ID is a safe no-op, verified live
  by posting the identical reference twice and confirming the
  operator's balance moved exactly once, not twice.

### A real bug found by the tests, not assumed away
`operator_ledger` uses a `BIGINT` primary key (same as `customer_ledger`,
Phase 3), but `audit_log.entity_id` is a `UUID` column — passing the
ledger row's own numeric id straight into `logActivity()` crashed with
a genuine Postgres type error the moment a real payable was posted.
Fixed by logging the *operator's* identity id (a real UUID, and the
semantically correct thing to reference anyway) instead, with the
ledger row's own id kept in the remarks text.

### Verified live (83 tests total now pass, all against real Postgres, from a genuinely fresh `node_modules` + database)
- A quote exactly at the reference rate is auto-accepted
- A quote under the reference rate is auto-accepted
- A quote over the reference rate is correctly left `pending_approval`
- Approving an already-decided quote a second time is rejected (409)
- `operator_ledger` is genuinely immutable — a direct `UPDATE`/`DELETE`
  attempted straight against the table (not through the API) is
  rejected by Postgres itself
- Ordinary staff (can submit quotes, but lack
  `vendorrates.quote.approve`) cannot approve one (403); staff without
  the separate `vendorrates.master.manage` cannot touch the master
  rate at all (403)

## Next: Phase 9

Per the blueprint's own module ordering: Finance & Invoicing —
invoice generation gated strictly on Delivered (mirroring the same
"hard gate checked at multiple independent points" discipline as
Phase 5's print-ready check), and the Customer Ledger's own
counterpart to this phase's Operator Ledger.
