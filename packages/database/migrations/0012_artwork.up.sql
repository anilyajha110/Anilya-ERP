-- 0012_artwork: the 3-stage AMS approval sequence and the single most
-- safety-critical rule in this entire project (see ADR 0002):
-- customer-approved artwork is NEVER automatically print-ready. An
-- earlier version of the prototype got this wrong once already — a
-- customer's own approval flowed straight into Gang Run planning — and
-- the fix (a second, internal-only approval gate) is preserved here
-- exactly, not reinvented.
--
-- Kept as its own 1:1 extension table (same pattern as customer_profiles
-- in Phase 3) rather than columns bolted onto `orders` — artwork
-- concerns don't apply to every order the same way a customer's own
-- profile data doesn't belong on every identity.
CREATE TABLE order_artwork (
  order_id                    UUID PRIMARY KEY REFERENCES orders(id),
  -- ART-001: 3-way intent, decided once at import and never guessed
  -- from file presence later. 'blank' means the order genuinely never
  -- needed artwork at all — it must print freely, gated on nothing.
  artwork_intent              TEXT NOT NULL CHECK (artwork_intent IN ('attachment', 'no', 'blank')),
  requires_artwork            BOOLEAN NOT NULL,
  -- ART-002: the 3 named AMS stages. NULL once cleared (print-ready)
  -- or for a 'blank'-intent order that never enters this workflow at all.
  ams_stage                   TEXT CHECK (ams_stage IN ('artwork_creator', 'artwork_verifier', 'final_artwork_inspector')),
  -- ART-003: the two artifacts that must NEVER be confused with each
  -- other. customer_approved_ref is a locked historical reference —
  -- nothing reads it to decide whether printing may start. Only
  -- print_ready (set exclusively by the Supervisor approval step)
  -- unlocks production.
  customer_approved_ref       TEXT,
  print_ready                 BOOLEAN NOT NULL DEFAULT false,
  print_ready_at              TIMESTAMPTZ,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ART-006: 4-stage file version history — CUSTOMER_UPLOAD,
-- CUSTOMER_APPROVED_ARTWORK, PRINT_REVIEWED, PRINT_APPROVED. Append-
-- only (the same genuine, trigger-enforced immutability as audit_log
-- and customer_ledger) — a version is never overwritten, corrected,
-- or replaced in place; a mistake is superseded by a NEW row.
--
-- File STORAGE itself (actual upload handling, object storage) is
-- deliberately out of scope for this phase — file_reference is a
-- filename/pointer only. A later Files/Storage phase plugs real
-- upload handling into this same schema without changing it.
CREATE TABLE artwork_versions (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id        UUID NOT NULL REFERENCES orders(id),
  stage           TEXT NOT NULL CHECK (stage IN ('customer_upload', 'customer_approved_artwork', 'print_reviewed', 'print_approved')),
  file_reference  TEXT NOT NULL,
  uploaded_by     UUID REFERENCES identities(id),
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX artwork_versions_order_idx ON artwork_versions (order_id, uploaded_at);

CREATE TRIGGER artwork_versions_no_update
  BEFORE UPDATE ON artwork_versions
  -- Reuses audit_log_prevent_mutation() from migration 0007 — same
  -- reasoning as customer_ledger (0009): its behavior is fully generic
  -- despite the name, and a prior migration's function isn't renamed
  -- after the fact.
  FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_mutation();

CREATE TRIGGER artwork_versions_no_delete
  BEFORE DELETE ON artwork_versions
  FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_mutation();
