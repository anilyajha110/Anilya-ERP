# Master Requirement Register — Anilya ERP
**Phase 0 — Forensic Prototype Audit** | Generated from source inspection of `server.js` (4,404 lines), `db.js` (1,125 lines), `inventory-*.js` (896 lines) — 191 endpoints, 73 tables, verified by grep against the actual codebase, not from memory or the original chat.

**Status legend:** IMPLEMENTED (built + live-tested at some point in the prototype) · PARTIAL (built but with a known gap) · MISSING (specified somewhere, not built)
**Classification legend (per blueprint §Phase 0):** REUSE · REFACTOR · REBUILD · REFERENCE · OBSOLETE · SECURITY BLOCKER

Every ID is stable and should be referenced by that ID in all future issues, ADRs, and test names — never by a description alone.

---
## REQ-AUTH — Identity, Authentication, Audit

| ID | Requirement | Status | Classification | Evidence / Note |
|---|---|---|---|---|
| AUTH-001 | Staff login (username+password), 12h session | IMPLEMENTED | REFACTOR | `POST /api/users/login`; bcrypt-hashed passwords — sound logic, SQLite-backed storage must move to Postgres |
| AUTH-002 | Partner login, 2-step password+OTP, 24h session | IMPLEMENTED | REFACTOR | `POST /api/auth/login` + `/verify-otp` |
| AUTH-003 | Customer OTP login (account-style, sees all own orders) | IMPLEMENTED | REFACTOR | `POST /api/customer-auth/request-otp` + `/verify-otp` — added late; UI for "all my orders" view was never built, only the API |
| AUTH-004 | Artwork Operator OTP login | IMPLEMENTED | REFACTOR | `POST /api/operator-auth/*` |
| AUTH-005 | Centralized OTP service: hash-only storage, never plaintext | IMPLEMENTED | REFACTOR | `otp_requests.otp_hash` (SHA-256); verified by direct DB inspection during build |
| AUTH-006 | Multi-channel OTP delivery tracking (SMS/WhatsApp/Email), independent status per channel | IMPLEMENTED | REFACTOR | `otp_channel_deliveries` — no real gateway connected, `status='Sent'` is simulated |
| AUTH-007 | OTP rate limiting (3 per identity / 15 min) | IMPLEMENTED | REUSE (logic) | Verified live: 4th request → 429 |
| AUTH-008 | Unified `login_sessions`: IP, device, method, duration, across every identity type | IMPLEMENTED | REFACTOR | One table, `identity_type` discriminator |
| AUTH-009 | Server-derived authorization via Bearer session token (`requireStaffAuth`) | IMPLEMENTED | REUSE (logic) | Replaced an earlier version that trusted a client-supplied `actorRole` string — **that earlier version's pattern still exists on ~50 lower-risk call sites**, see RISK-003 |
| AUTH-010 | Real-time structured audit (`logActivity`): user, role, action type, master/order/job id, old/new value, IP, session | PARTIAL | REFACTOR | Wired into login/logout and `applyTransition` (all stage changes); **NOT wired into most other mutating endpoints** (inventory, complaints, finance) — those still use the older, less-structured `addAudit` |
| AUTH-011 | Audit log immutability (no UPDATE/DELETE route) | IMPLEMENTED | REUSE (logic) | True by omission (no route exists), not by DB-level constraint (no `ON CONFLICT`/trigger enforcement) |
| AUTH-012 | Admin-only audit/session reports, filterable by role/user/date | IMPLEMENTED | REFACTOR | `GET /api/audit/report`, `/api/audit/sessions[/:id]`; RBAC-gated to Super Admin/Operations Admin only |
| AUTH-013 | RBAC role set | PARTIAL | REFACTOR | Roles used inconsistently: Staff roles (`Super Admin`, `Operations Admin`, `Manager`, `Supervisor`, `Support Executive`) are a flat enum on `users.role`; Partner "roles" are really `capability_types` (Printer/Supplier/Processor/Courier/Binder) via a many-to-many table — **two different RBAC shapes for two identity types, not unified** |
| AUTH-014 | Multi-tenant / organization boundary | MISSING | REBUILD | No `organization_id`/tenant concept anywhere in the schema. Every table implicitly assumes a single tenant (Anilya). This is the single largest gap versus the target architecture. |
| AUTH-015 | Dead code: legacy `login_otps` table | — | OBSOLETE | Defined in `db.js`, zero references in `server.js` — superseded by AUTH-005/006 during a later pass, never dropped |

## REQ-CRM — Customer & Master Data

| ID | Requirement | Status | Classification | Evidence |
|---|---|---|---|---|
| CRM-001 | Customer find-or-create by phone→email→dummy, one CUST-ID per person | IMPLEMENTED | REUSE (logic) | `findOrCreateCustomer()` |
| CRM-002 | Structured billing profile: Name→GSTIN→Address→City→District→State→PIN | IMPLEMENTED | REUSE (logic) | Added `billing_name`, `gstin`, `billing_city`, `billing_district`, `billing_pincode` columns; GSTIN flows Booking Portal→DB→Invoice |
| CRM-003 | Customer ledger (append-only, `Final = Previous + Job Value − Payment ± Adjustment`) | IMPLEMENTED | REFACTOR | `customer_ledger` — correct accounting shape, needs real double-entry review before production |
| CRM-004 | Customer dedup / import preview / dry-run / rollback | MISSING | REBUILD | Booking Portal import is direct insert; no preview, no dry-run, no rollback path exists |
| CRM-005 | Customer self-service portal (profile, address book, order history) | MISSING | REBUILD | Only the single-order tracking page and the new (AUTH-003) OTP login exist; no "my account" surface was built |

## REQ-ORD — Booking, Order Lifecycle, Cancellation

| ID | Requirement | Status | Classification | Evidence |
|---|---|---|---|---|
| ORD-001 | Order import from Booking Portal (Excel/API shape), duplicate-safe | IMPLEMENTED | REBUILD | `POST /api/orders/import` — **direct-write pattern the blueprint explicitly forbids** ("Anilya customer/booking platform must never write directly to ERP database tables"); needs a real versioned ingestion API + idempotency key, not a raw row insert |
| ORD-002 | Central order state machine (14 stages, Imported→Delivered) | IMPLEMENTED | REFACTOR | `STAGES` array + `TRANSITIONS` map in `applyTransition()` — sound state-machine logic, but stage names/rules are hard-coded, not data-driven or versioned |
| ORD-003 | Display Job Number generation, synced back to Booking Portal | IMPLEMENTED | REUSE (logic) | `ANILYA/YYYY/MM/#####` |
| ORD-004 | Single unique public Tracking URL per order, live-updating | IMPLEMENTED | REUSE (logic) | `/track/:token` |
| ORD-005 | Shipping address shown publicly on tracking page, phone never shown | IMPLEMENTED | REUSE (logic) | Verified live: grepped rendered HTML for phone digits, zero matches |
| ORD-006 | Order cancellation, stage-gated, kept separate from post-delivery complaint | IMPLEMENTED | REFACTOR | `POST /api/orders/:id/cancel` — has no RBAC/approval gate of its own yet (blueprint requires "Cancellation Approved/Rejected" as an authorized decision, not just an open endpoint) |
| ORD-007 | Idempotent order ingestion (retries/duplicate webhooks produce no duplicate effect) | PARTIAL | REBUILD | Import is duplicate-safe on `Product Wise Order ID`, but there is no idempotency-key contract at the API layer generally (no `Idempotency-Key` header pattern used anywhere) |
| ORD-008 | On-behalf actions require mandatory reason | IMPLEMENTED | REUSE (logic) | Enforced in `applyTransition` |

## REQ-ART — Artwork Management System (AMS) Integration

| ID | Requirement | Status | Classification | Evidence |
|---|---|---|---|---|
| ART-001 | 3-way intent detection at import: attachment / "No" / blank | IMPLEMENTED | REUSE (logic) | `artworkIntent` derivation |
| ART-002 | 3 named AMS stages: `ARTWORK_CREATOR`, `ARTWORK_VERIFIER`, `FINAL_ARTWORK_INSPECTOR` | IMPLEMENTED | REUSE (logic) | `orders.ams_stage`, verified live through full progression |
| ART-003 | **Critical rule: customer-approved artwork ≠ print-ready** | IMPLEMENTED | REUSE (logic) — highest-priority rule to preserve verbatim | `final_artwork_url` (customer-approved, locked reference) vs `final_internal_approved_artwork` (print gate); gate enforced in `applyTransition` on `start-production` |
| ART-004 | Gang Run requires each member's individual internal approval BEFORE gang-level combination | IMPLEMENTED | REUSE (logic) | Verified live: gang-approve blocked (409) until prerequisite met |
| ART-005 | Gang Run Shadow/temporary ID, closes on completion, full audit trail preserved | IMPLEMENTED | REUSE (logic) | `gang_runs.id` doubles as `temporary_gang_run_id` |
| ART-006 | 4-stage file versioning with fixed download names (`JOBID_CUSTOMER_UPLOAD` etc.), never overwritten | IMPLEMENTED | REBUILD | Logic is correct and live-tested (incl. two real bugs found: `/` in filenames, folder-column desync after move) — but files live on **local server disk** (`storage/temp`, `storage/used`), which the blueprint explicitly forbids for production ("never depend on local ephemeral server disk for production files") |
| ART-007 | File type allow-list + 300MB size cap, identical for upload and re-upload | IMPLEMENTED | REUSE (logic) | Shared multer instance; verified live at the exact 260MB/310MB boundary |
| ART-008 | Full artwork version history endpoint | IMPLEMENTED | REUSE (logic) | `GET /api/artwork/:orderId/versions` |

## REQ-JOB — Job Engine, Escalation, Vendor Rates

| ID | Requirement | Status | Classification | Evidence |
|---|---|---|---|---|
| JOB-001 | Job lifecycle (Open→Assigned→InProgress→Completed), Fixed vs Extra category | IMPLEMENTED | REUSE (logic) | |
| JOB-002 | qc-pass gate: ALL jobs on an order must be Completed | IMPLEMENTED | REUSE (logic) | Verified: 409 with the exact list of pending jobs |
| JOB-003 | 5-trigger Manager escalation (no supervisor online / never assigned / timeout / rejected / emergency) | IMPLEMENTED | REUSE (logic) | |
| JOB-004 | Partner-never-logged-in-cannot-receive-direct-job rule | IMPLEMENTED | REUSE (logic) | |
| JOB-005 | Vendor rate quote → auto-accept at/under reference, else Manager approval | IMPLEMENTED | REUSE (logic) | |
| JOB-006 | Master rate never auto-updates from a one-off approval (explicit opt-in only) | IMPLEMENTED | REUSE (logic) | |
| JOB-007 | Artwork Operator payment ledger, AMS-final-amount-only (no rate math in ERP) | IMPLEMENTED | REUSE (logic) | Verified live: duplicate `WORK_ID` replay is a no-op, not a double-charge |

## REQ-INV — Inventory Phase 1 (separate module)

| ID | Requirement | Status | Classification | Evidence |
|---|---|---|---|---|
| INV-001 | Product identity engine, external-ID mapping scoped by (source, customer) | IMPLEMENTED | REFACTOR | `inventory-service.js` |
| INV-002 | Idempotent inbound events (`event_id` replay-safe) | IMPLEMENTED | REUSE (logic) | Verified: 19/19 automated safety checks in `test-inventory-safety.js` |
| INV-003 | Concurrency-safe reservation (never negative, never over-reserved) | IMPLEMENTED | REFACTOR | Correctness relies partly on `better-sqlite3`'s single-writer synchronous execution — **this guarantee does not automatically carry over to Postgres with real concurrent connections**; needs explicit row-level locking (`SELECT ... FOR UPDATE`) in the rebuild |
| INV-004 | Atomic ledger + snapshot (all-or-nothing) | IMPLEMENTED | REFACTOR | Same concurrency caveat as INV-003 |
| INV-005 | Outbox + retry (5 attempts) + dead-letter + audited replay | IMPLEMENTED | REUSE (logic) | |
| INV-006 | Zone/City/Godown hierarchy, RBAC scope (Manager/Supervisor/Keeper) | IMPLEMENTED | REUSE (logic) | |
| INV-007 | Bulk supplier-product mapping (paste IDs, submitted/mapped/existing/invalid) | IMPLEMENTED | REUSE (logic) | |
| INV-008 | Warehouse resolution when ORDER_CREATED doesn't name one explicitly | MISSING | REBUILD | Falls back to "first warehouse in the table" — explicitly flagged as a placeholder when built |
| INV-009 | Full PO/GRN/Transfer/Consignment/Batch/Cycle-Count workflow | MISSING (by design) | REBUILD | Explicitly out of Phase 1 scope per the source Inventory spec itself |

## REQ-FIN — Finance, Invoicing, Refunds

| ID | Requirement | Status | Classification | Evidence |
|---|---|---|---|---|
| FIN-001 | Invoice generated only after Delivered, hard-blocked at every layer (not just UI) | IMPLEMENTED | REUSE (logic) | Verified live at 3 independent enforcement points |
| FIN-002 | OTP-protected invoice download, registered mobile only, masked on screen | IMPLEMENTED | REUSE (logic) | `/invoice/:token` flow; verified live incl. 3-attempt lockout and 30-min resend limit |
| FIN-003 | Accounting Clearance task pipeline (Verify→Invoice→Post-Ledger→Clear) | IMPLEMENTED | REUSE (logic) | |
| FIN-004 | Payment type bridges: Online refund, Wallet credit, COD collection | IMPLEMENTED | REFACTOR | Each is a queue+sync bridge to a not-yet-built external system — correct shape, unproven against a real gateway |
| FIN-005 | Refund/Replacement resolution reuses the Refund Bridge + Customer Ledger (not a parallel system) | IMPLEMENTED | REUSE (logic) | Verified live: complaint-approved refund appears in both simultaneously |
| FIN-006 | GST e-way bill / real tax engine | MISSING (by design) | REBUILD | Explicitly deferred in the source Inventory spec |

## REQ-CMP — Complaints, Feedback, Resolution

| ID | Requirement | Status | Classification | Evidence |
|---|---|---|---|---|
| CMP-001 | Feedback and Complaint kept deliberately separate (no auto-ticket from low rating) | IMPLEMENTED | REUSE (logic) | |
| CMP-002 | One Job → Multiple Tickets | IMPLEMENTED | REUSE (logic) | Verified live: 2 independent tickets on one order |
| CMP-003 | Customer states a *requested* resolution; only Manager+ can *approve* Refund/Replacement | IMPLEMENTED | REUSE (logic) — the single most safety-critical rule in this module | Verified live: unauthenticated 401, Support Executive 403, Manager 200 |
| CMP-004 | Evidence upload (photo/video/doc), reuses the central File service | IMPLEMENTED | REUSE (logic) | |
| CMP-005 | "Evidence Required" reuses the same ticket, never creates a new one | IMPLEMENTED | REUSE (logic) | Verified live |
| CMP-006 | Replacement creates a new order, original's history untouched | IMPLEMENTED | REUSE (logic) | Verified live: original stayed exactly `Delivered` |
| CMP-007 | Full structured audit trail per ticket (who/when/what/prev→new) | IMPLEMENTED | REUSE (logic) | `complaint_audit_log`, separate from AUTH-010's `logActivity` — **two parallel audit mechanisms, not unified**, see RISK-004 |

## REQ-LOG — Logistics, Notifications

| ID | Requirement | Status | Classification | Evidence |
|---|---|---|---|---|
| LOG-001 | Parcel bundling for dispatch, cascades status to member orders | IMPLEMENTED | REUSE (logic) | |
| LOG-002 | Parcel split at hub, orders proceed independently | IMPLEMENTED | REUSE (logic) | |
| LOG-003 | Notification routing matrix (type × recipient → channel), rule changes don't retroactively rewrite history | IMPLEMENTED | REUSE (logic) | |
| LOG-004 | Real SMS/WhatsApp/Email gateway integration | MISSING | REBUILD | Every "send" in the system (OTP, invoice, notifications) is simulated — `demoOtp` returned directly in API responses throughout |

## REQ-SEC — Security Controls (see SECURITY_AUDIT.md for full detail)

| ID | Requirement | Status | Classification | Evidence |
|---|---|---|---|---|
| SEC-001 | Stored XSS on public pages | FIXED | REUSE (logic) | `escapeHtml()` — was a proven, exploited bug before the fix |
| SEC-002 | Client-supplied `actorRole` trusted instead of session-derived identity | PARTIAL | **SECURITY BLOCKER** | Fixed on 6 highest-value endpoints (rate approval, clearance, manager actions, payments); **~50 lower-risk call sites still trust the client-supplied string** — direct violation of the blueprint's Mandatory Principle #8 |
| SEC-003 | Centralized File Upload access control | OPEN | **SECURITY BLOCKER** | `checkFileAccess()` is a documented, deliberate pass-through stub — anyone with any file link can use it, regardless of session |
| SEC-004 | CORS default-open until `ALLOWED_ORIGINS` is set | OPEN | SECURITY BLOCKER (deployment-time) | Warns loudly on startup; not actually closed by default |
| SEC-005 | Integration/API keys, OTPs hashed not plaintext | FIXED | REUSE (logic) | |
| SEC-006 | Rate limiting on auth endpoints | FIXED | REUSE (logic) | |
| SEC-007 | No automated security regression suite | MISSING | REBUILD | Every finding above was verified by hand, once, during the build session that introduced it — nothing re-runs automatically |
