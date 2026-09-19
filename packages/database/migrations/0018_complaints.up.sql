-- 0018_complaints: post-delivery complaints, deliberately separate
-- from Feedback (CMP-001 — a low star rating never auto-creates a
-- ticket; a complaint is always something the customer actively
-- raised). The single most safety-critical rule in this module
-- (CMP-003): a customer can only ever REQUEST a resolution —
-- requested_resolution is free text, never actioned by itself.
-- Only resolve() (Manager+, its own permission) can set
-- resolution_type and actually move money or create a replacement
-- order — the exact same "customer proposes, Manager approves"
-- shape as JOB-005's vendor rate quotes (Phase 8).
CREATE TABLE complaint_tickets (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES organizations(id),
  order_id              UUID NOT NULL REFERENCES orders(id),
  customer_identity_id  UUID NOT NULL REFERENCES identities(id),
  category              TEXT NOT NULL,
  description           TEXT NOT NULL,
  -- The customer's own wish, in their own words — NEVER a status this
  -- table treats as a decision. See resolution_type below for the
  -- actual, Manager-made decision.
  requested_resolution  TEXT,
  status                TEXT NOT NULL DEFAULT 'raised'
                           CHECK (status IN ('raised', 'under_review', 'evidence_required', 'resolution_pending', 'resolved', 'rejected', 'closed')),
  -- Set ONLY by resolve() — the real, authoritative decision, distinct
  -- in kind from requested_resolution above, not just in value.
  resolution_type       TEXT CHECK (resolution_type IN ('refund', 'replacement', 'credit', 'rejected', 'other')),
  resolution_notes      TEXT,
  resolved_by           UUID REFERENCES identities(id),
  resolved_at           TIMESTAMPTZ,
  -- CMP-006: set only for a 'replacement' resolution. The ORIGINAL
  -- order's own row is never touched by a replacement — this column is
  -- the only link between the two, on the ticket, not on the order.
  replacement_order_id  UUID REFERENCES orders(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX complaint_tickets_order_idx ON complaint_tickets (order_id);
CREATE INDEX complaint_tickets_org_status_idx ON complaint_tickets (organization_id, status);

-- CMP-004: evidence attached to a ticket. Real file STORAGE is
-- deliberately out of scope here (no object-storage phase has been
-- built yet in this rebuild) — file_reference is a filename/pointer
-- only, the same deliberate scoping choice as artwork_versions
-- (Phase 5). Append-only: evidence is never replaced, only added to.
CREATE TABLE complaint_evidence (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id     UUID NOT NULL REFERENCES complaint_tickets(id),
  file_reference TEXT NOT NULL,
  uploaded_by   UUID REFERENCES identities(id),
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX complaint_evidence_ticket_idx ON complaint_evidence (ticket_id);

CREATE TRIGGER complaint_evidence_no_update
  BEFORE UPDATE ON complaint_evidence
  FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_mutation();

CREATE TRIGGER complaint_evidence_no_delete
  BEFORE DELETE ON complaint_evidence
  FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_mutation();

-- CMP-007: full structured audit trail — deliberately does NOT create
-- a parallel complaint_audit_log table (the prototype's own Phase 0
-- audit flagged exactly that as a real problem: four independent,
-- non-unified audit tables). Every ticket action is logged through
-- the SAME identity module logActivity()/audit_log used by every
-- other phase since Phase 2 — entity_type = 'complaint_ticket' is
-- simply another value in that one shared table.
