-- 0009_customer_ledger: append-only running balance (CRM-003). Same
-- genuine database-level immutability as audit_log (0007) — a
-- correction is always a NEW row with an Adjustment entry, never an
-- edit of history. This was flagged in the Phase 0 audit as needing
-- "real double-entry review before production" — Phase 3 keeps the
-- single-column running-balance shape from the prototype (adequate for
-- this domain) rather than a full double-entry ledger, which would be
-- a disproportionate rebuild for what this system actually needs.
CREATE TABLE customer_ledger (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id   UUID NOT NULL REFERENCES organizations(id),
  customer_identity_id UUID NOT NULL REFERENCES identities(id),
  particular        TEXT NOT NULL CHECK (particular IN ('job', 'payment', 'adjustment')),
  previous_balance  NUMERIC(12, 2) NOT NULL,
  job_value         NUMERIC(12, 2) NOT NULL DEFAULT 0,
  payment_amount    NUMERIC(12, 2) NOT NULL DEFAULT 0,
  adjustment        NUMERIC(12, 2) NOT NULL DEFAULT 0,
  final_balance     NUMERIC(12, 2) NOT NULL,
  -- Final = Previous + Job Value - Payment +/- Adjustment, enforced by
  -- the database itself, not just by application code being careful.
  CONSTRAINT customer_ledger_balance_check
    CHECK (final_balance = previous_balance + job_value - payment_amount + adjustment),
  remarks           TEXT,
  created_by        UUID REFERENCES identities(id),   -- who posted this entry — null only for system-generated entries
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX customer_ledger_customer_idx ON customer_ledger (customer_identity_id, created_at);

CREATE TRIGGER customer_ledger_no_update
  BEFORE UPDATE ON customer_ledger
  -- Reuses audit_log_prevent_mutation() from migration 0007 — its
  -- behavior (reject any UPDATE/DELETE via TG_OP) is fully generic
  -- despite the audit_log-specific name. Not renamed here because
  -- migration 0007 has already shipped to a real environment; renaming
  -- a function a prior migration created would break anyone who already
  -- ran it. A cleaner name is a fine cleanup for a future migration
  -- that drops and recreates it properly, not a reason to edit history.
  FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_mutation();

CREATE TRIGGER customer_ledger_no_delete
  BEFORE DELETE ON customer_ledger
  FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_mutation();
