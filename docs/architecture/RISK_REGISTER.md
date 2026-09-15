# Risk Register — Anilya ERP Phase 0

Ordered by severity. Each risk is evidence-based (verified against the actual codebase during this audit or a prior build session), not speculative.

## CRITICAL — block production deployment as-is

| ID | Risk | Evidence | Recommended Owner Phase |
|---|---|---|---|
| RISK-001 | **No multi-tenant boundary exists anywhere.** Every table assumes a single organization. Any SaaS ambition requires this as a foundational rebuild, not a later add-on — retrofitting `organization_id` onto 73 existing tables after data exists is far more dangerous than building it in from Phase 1. | Verified: zero `organization_id`/`tenant_id` columns in `db.js` or `inventory-db.js`. | Phase 2 |
| RISK-002 | **SQLite is not a production database for this workload.** Single-writer, file-based, no real row-level locking, no built-in replication/PITR. The Inventory reservation concurrency-safety (INV-003) is partly an accident of SQLite's single-writer behavior, not a guarantee that survives a rewrite to a real multi-connection database. | Confirmed via `better-sqlite3` usage throughout; concurrency tests in `test-inventory-safety.js` do not exercise true parallel connections. | Phase 1 |
| RISK-003 | **~50 lower-risk endpoints still trust a client-supplied `actorRole` string** for audit attribution (not always for authorization, but the boundary is easy to blur). A partial fix was applied to the 6 highest-value endpoints (payments, rate approval, clearance); the rest were explicitly deferred and never closed. | `grep -c actorRole server.js` → still present at dozens of sites; SECURITY_AUDIT.md's own "Fix Status" table marks this "Partially fixed." | Phase 2 |
| RISK-004 | **Centralized File Upload access control (`checkFileAccess`) is a no-op.** Any file — customer artwork, complaint evidence, invoices — is downloadable by anyone who obtains the link, with zero session check. | `server.js` line ~2035, explicitly commented as a deliberate testing-phase stub, never re-enabled. | Phase 2 (ties to AUTH work) |
| RISK-005 | **Files live on local server disk**, not object storage. A server restart, redeploy, or horizontal scale-out loses or fragments file access. Every "production file" requirement in the blueprint (artwork versions, invoices, complaint evidence) is affected. | `storage/temp/`, `storage/used/` are local directories created by the Node process itself. | Phase 1 |
| RISK-006 | **No real external gateway is connected for SMS/WhatsApp/Email/Payment.** Every OTP in the system returns `demoOtp` directly in the API response. This is correct and necessary for a demo, but means **zero real-world delivery-failure behavior has ever been exercised** — a production cutover is the first time this code path will see a real failure mode. | Documented inline at every OTP/notification call site. | Phase 10 |

## HIGH — must close before real customer data is trusted to the system

| ID | Risk | Evidence |
|---|---|---|
| RISK-007 | Order import (`POST /api/orders/import`) is a direct-write endpoint the Booking Portal calls with no idempotency-key contract beyond a single natural-key duplicate check, and no preview/dry-run/rollback. Violates the blueprint's own Mandatory Principle #3 ("API-first integration... no external application may directly mutate ERP database tables") in spirit even though it is technically an API. |
| RISK-008 | Two parallel, non-unified audit mechanisms exist: the newer structured `logActivity()`/`audit_logs` (AUTH-010) and the older `addAudit()` calls still used at most mutation points, plus a THIRD, separate `complaint_audit_log` table for CMP-007. A real compliance/audit report has to reconcile three sources, not one. |
| RISK-009 | Inventory's warehouse-auto-resolution (INV-008) silently defaults to "the first warehouse in the table" when an order doesn't specify one — a correctness bug waiting to surface the moment a second warehouse exists in real data. |
| RISK-010 | No automated test suite runs on every change. Every "verified live" note throughout the Master Requirement Register was a manual, one-time curl/script session during the build that introduced the feature — nothing re-runs to catch a regression introduced by a later change. Confirmed directly: this audit found genuine regressions (a malformed `<script>` tag, an FK-constraint crash, a stray-backtick syntax error) introduced by later features breaking earlier ones, each only caught because a human happened to test that exact path afterward. |
| RISK-011 | CORS defaults open (warns, does not block) until an operator remembers to set `ALLOWED_ORIGINS`. Easy to forget at first real deployment. |

## MEDIUM — should be resolved during the corresponding phase, not blocking

| ID | Risk |
|---|---|
| RISK-012 | RBAC shape is inconsistent between Staff (flat `role` enum) and Partner (many-to-many `capability_types`) — a unified permission model will need to reconcile these, likely a breaking schema change either way. |
| RISK-013 | Hard-coded demo credentials (`admin1234`, `demo1234`, etc.) are gated behind `SKIP_DEMO_SEED`/`NODE_ENV` checks added late — correct now, but relies on an operator setting the right environment variable at deploy time; nothing prevents accidentally deploying with seeding on. |
| RISK-014 | Stage/status enums (`STAGES`, complaint statuses, resolution types) are hard-coded JS arrays, not data-driven — changing a business rule requires a code deploy, not a config change. |
| RISK-015 | No SBOM, no dependency/secret scanning, no container scanning has ever run against this codebase — the blueprint's supply-chain baseline (SLSA-aligned) has zero coverage today. |

## Dead code / hygiene (LOW, but free to fix)

| ID | Finding |
|---|---|
| RISK-016 | `login_otps` table defined in schema, zero live references — superseded by the centralized OTP service, never dropped. |
