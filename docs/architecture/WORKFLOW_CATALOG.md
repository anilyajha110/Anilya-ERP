# Workflow Catalog — Anilya ERP

Every multi-step business process the prototype actually implements, as state machines or event chains. This is what Phase 4+ must formalize into the target's explicit "central state machine" + "outbox/domain events."

## 1. Order Lifecycle (core state machine)
`Imported → ArtworkPending → ArtworkInProgress → ArtworkApproved → Broadcasted → Assigned → HandedOff → InProduction → QCPending → ReadyForPackaging → Packed → Dispatched → OutForDelivery → Delivered`
Alternate exits: `Cancelled` (pre-delivery only, stage-gated), post-delivery issues go through the Complaint workflow instead (never a stage on this machine).
**Gate:** `start-production` transition is blocked unless `final_internal_approved_artwork` is set (see ART-003) AND unless artwork wasn't required at all.

## 2. Artwork Approval (3-stage AMS simulation)
`ARTWORK_VERIFIER or ARTWORK_CREATOR (at import) → [Customer Approval] → FINAL_ARTWORK_INSPECTOR (automatic) → [Operator technical check + Supervisor approval] → cleared (ams_stage = null, print-ready)`
Runs individually per order, UNLESS the order is pooled into a Gang Run, in which case a parallel, gang-level version of the same final-approval step (Workflow 3) supersedes it.

## 3. Gang Run
`Open (pool jobs) → [prerequisite: every member already individually FINAL_ARTWORK_INSPECTOR-approved] → Approved (Supervisor+) → PendingGangArtworkSetup → ArtworkReady (combined file locked) → member orders' start-production unlocks → Completed (temporary ID closes, members continue independently)`

## 4. Manager Escalation
5 independent triggers converge on one queue: no Supervisor of the department online / no Supervisor ever assigned / timeout / Supervisor rejected / Emergency priority at creation. Manager resolves by direct-assign or self-approve; both exit the escalation queue.

## 5. Vendor Rate Approval
`Vendor quotes → compare to reference rate → (≤ reference: auto-approved) OR (> reference: Manager queue) → Approve/Reject/Negotiate/Revise → [explicit opt-in only] update master reference rate`

## 6. Artwork Operator Payment
`AMS reports completed work + final payable amount (ERP never recalculates) → post to Operator Ledger, keyed by unique WORK_ID (replay-safe) → running balance → Payment recorded → posted to ledger → balance decreases → Paid when balance ≤ 0`

## 7. Accounting Clearance (post-delivery)
`Order Delivered → clearance task auto-created → Verify → Invoice (generates invoice + secure download token) → Post-Ledger → Clear`

## 8. Invoice Download (customer-facing, OTP-gated)
`Delivered (hard gate, checked independently at 3 points) → request OTP to registered mobile (masked on screen) → verify (3 attempts, 5-min expiry, 30-min/3-request resend limit) → serve real downloadable file`

## 9. Complaint & Resolution
`Delivered → customer raises ticket (category + description + evidence + requested resolution) → Support Executive reviews → Supervisor investigates → [ONLY Manager+] resolves: Reject / Evidence-Required (same ticket) / Refund (→ existing Refund Bridge + Customer Ledger) / Replacement (→ new order, original untouched) / Credit → Closed`

## 10. Inventory Reservation (isolated module, mirrors Workflow 1's rigor)
`Inbound ORDER_CREATED event (idempotent on event_id) → resolve/auto-create Product identity → resolve warehouse (currently: naive first-match, see INV-008) → atomic reserve-or-reject → outbox event out → retry up to 5x → dead-letter → audited manual replay`

## 11. Centralized Authentication (cross-cutting, wraps every other workflow)
`Password and/or OTP (OTP never stored plaintext, multi-channel fan-out) → login_sessions row created (IP/device/method/duration) → every subsequent state-changing action in Workflows 1–10 is expected to log through logActivity() — currently true only for login/logout and order-stage transitions (see AUTH-010 in the Requirement Register)`
