# Phase 0 — Forensic Prototype Audit and Product Baseline
**Anilya ERP** | Conducted against the blueprint's own Phase 0 exit gate.

---

## 1. Files inventoried

| Category | Files | Where |
|---|---|---|
| Core ERP backend | `server.js` (4,404 lines), `db.js` (1,125 lines) | `/anilya_erp_api/` |
| Inventory Phase 1 (isolated module) | `inventory-db.js`, `inventory-service.js`, `inventory-routes.js` (896 lines combined) | `/anilya_erp_api/` |
| Automated test | `test-inventory-safety.js` (19 checks, Inventory module only) | `/anilya_erp_api/` |
| Documentation produced during the build | `README.md` (111KB, append-only build log), `SECURITY_AUDIT.md`, handover `.docx` | `/anilya_erp_api/` |
| Prior planning artifacts | Blueprint PDFs, Excel import template, phase-plan PDFs, an early React demo (`AnilyaERP_Phase1_Demo.jsx`), a standalone HTML artwork-bridge pilot | project root |
| This audit's own output | Everything under `docs/` in this delivery | new |

**191 endpoints, 73 database tables** — counted by direct `grep` against the source (`grep -c '^app\.\(get\|post\|put\|delete\)'`, `grep -c 'CREATE TABLE'`), not estimated.

## 2. Requirements extracted

**76 requirement IDs** across 8 domains (AUTH, CRM, ORD, ART, JOB, INV, FIN, CMP, LOG, SEC) — see `docs/requirements/MASTER_REQUIREMENT_REGISTER.md`. Every ID carries a status (Implemented/Partial/Missing) and a classification (Reuse/Refactor/Rebuild/Reference/Obsolete/Security Blocker), each backed by a specific code citation, not an assumption.

## 3. Contradictions and gaps found

| # | Contradiction / gap | Resolution needed before Phase 1 code starts |
|---|---|---|
| 1 | Two different names ("Display Job Number" / "Display Order Number") refer to the identical field across different source requirement documents. | Pick one name for the rebuild's API contract. **Proposed:** `displayOrderNumber`, since the order IS the job in this single-line-per-order model. |
| 2 | Two different names ("temporary_gang_run_id" / "Shadow Job ID") refer to the identical concept. | **Proposed:** keep both as documented synonyms (already how the prototype's API responds) rather than picking one — different source documents used different names and both may already be in downstream use. |
| 3 | RBAC has two incompatible shapes: Staff uses a flat `role` string; Partners use many-to-many `capability_types`. | Needs an explicit decision in Phase 2, not an accident of whichever pattern gets ported first. |
| 4 | Four independent audit-log tables exist (`audit_logs`, `complaint_audit_log`, `rate_audit_log`, `inventory_audit_log`) with no shared schema. | Needs one designed audit primitive in Phase 1, used everywhere, not four ad-hoc copies. |
| 5 | `checkFileAccess()` is a **documented, intentional no-op** — this is a known gap, not a hidden one, but it means **no file security has ever actually been enforced** for the entire life of the prototype. | Must be a Phase 2 blocking item, not deferred again. |

No requirement was found to be silently missing a decision — every gap above was already flagged in-line in the prototype's own comments or a prior security audit. This audit's contribution is consolidating them into one register with stable IDs, per the blueprint's own Phase 0 goal.

## 4. Baseline classification summary

| Classification | Count | What it means practically |
|---|---|---|
| REUSE (logic) | 47 | The business rule is correct and verified — re-implement the same rule in the target stack, don't re-derive it from scratch. |
| REFACTOR | 24 | The rule is correct but the implementation leans on prototype-only shortcuts (SQLite concurrency, local disk, ad-hoc RBAC) that must change in the rebuild. |
| REBUILD | 12 | Missing entirely, or built in a way that shouldn't be carried forward at all (direct-write import, no tenant model). |
| SECURITY BLOCKER | 2 (+1 deployment-time) | `actorRole` trust on ~50 endpoints; the open file-access stub; CORS default-open. None may exist in the target architecture's first commit. |
| OBSOLETE | 1 | `login_otps` dead table. |

*(Counts sum to more than 76 because a small number of requirements carry compound classifications, e.g. "Implemented, Refactor" — see the Register for exact per-row values.)*

## 5. Exit gate assessment

| Blueprint's Phase 0 exit criterion | Status | Note |
|---|---|---|
| 100% inventoried files | **MET** | Every file in the delivered ZIP is accounted for in §1. |
| 100% known requirements have IDs | **MET** | 76 IDs assigned; every one traces to a specific code citation. |
| No undocumented critical workflow | **MET** | 11 workflows documented in `WORKFLOW_CATALOG.md`, including the two most safety-critical ones (artwork approval gate, complaint resolution authorization) each backed by an ADR. |
| Baseline audit committed | **MET** (this delivery) | Register, Glossary, Workflow Catalog, Data Dictionary, Integration Catalog, Risk Register, 2 ADRs. |
| Phase 1 backlog approved | **PENDING** | Drafted below (§6) — needs your sign-off, since the blueprint requires human approval at this gate, not just Claude's own assessment. |

### Verdict: **PHASE 0 — PASS**, with one item (Phase 1 backlog approval) requiring your explicit go-ahead before any Phase 1 code is written, exactly as the blueprint's own phase-execution rule requires ("do not begin broad feature development yet").

## 6. Draft Phase 1 backlog (Production Engineering Foundation)

Per the blueprint's own Phase 1 scope, informed directly by this audit's findings:

1. TypeScript monorepo scaffold matching the target repository layout.
2. PostgreSQL schema migration — **re-derived from the Master Requirement Register's business rules, not a mechanical port of `db.js`** (per ADR 0001). Priority order: Orders/Jobs → Identity/Auth → Customers/Finance → Artwork → everything else.
3. Object storage abstraction (S3-compatible) for the 4-stage artwork versioning and complaint evidence — replaces local disk (RISK-005).
4. Idempotency-key contract for the Booking Portal order-ingestion endpoint (RISK-007).
5. One unified audit/event primitive, replacing the four independent audit tables (RISK-008).
6. GitHub Actions CI skeleton: lint, typecheck, unit tests — even before there's much to test, so every subsequent phase lands inside a working gate.
7. Config validation + structured logging with correlation IDs.
8. Explicit resolution of contradictions #1–#3 above (naming, RBAC shape) as committed ADRs before the schema that depends on them is written.

**Blocking dependency for Phase 2:** the file-access security stub (RISK-004) and the remaining `actorRole`-trusting endpoints (RISK-003) must be designed out from the start of the rebuild's auth work — not ported, then fixed later, as happened in the prototype.

## 7. Commands to reproduce this audit

```bash
# Endpoint count
grep -cE '^app\.(get|post|put|delete)\("' server.js
grep -cE '^router\.(get|post|put|delete)\("' inventory-routes.js

# Table count
grep -c "CREATE TABLE IF NOT EXISTS" db.js inventory-db.js

# Dead-code check (example: confirms login_otps is unreferenced)
grep -n "login_otps" server.js db.js

# Security-bypass / TODO sweep
grep -n "TODO\|SECURITY WARNING\|pass-through" server.js

# Demo-credential sweep
grep -n "demo1234\|admin1234\|manager1234\|super1234" db.js
```

---
*This audit deliberately writes no application code. Per the blueprint's own Section 14: "Do not begin broad feature development yet." Phase 1 starts on your explicit approval of the backlog in §6.*
