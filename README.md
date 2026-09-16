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

## Next: Phase 2

Organization/Identity/RBAC/Audit, per `docs/PHASE_0_AUDIT_REPORT.md` §6
and the blueprint's own phase ordering. Do not begin Phase 2 schema work
until the two SECURITY BLOCKER items in `docs/architecture/RISK_REGISTER.md`
(client-trusted role claims; open file-access stub) are designed out of
the new auth module from the start — not ported from the prototype, then
patched later, as happened previously.
