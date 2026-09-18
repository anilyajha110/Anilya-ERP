-- 0016_operator_ledger: JOB-007. The ERP NEVER recalculates a
-- payable amount — it only records whatever final figure AMS (or
-- whichever external system) reports for a unit of completed
-- artwork work, exactly the same "trust the external final amount,
-- do no rate math here" principle already applied to
-- reference_rate_at_quote in migration 0015. Append-only, same
-- genuine database-enforced immutability as customer_ledger (0009)
-- and audit_log (0007) — a correction is always a new row, never an
-- edit to history.
CREATE TABLE operator_ledger (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id   UUID NOT NULL REFERENCES organizations(id),
  operator_identity_id UUID NOT NULL REFERENCES identities(id),
  particular        TEXT NOT NULL CHECK (particular IN ('payable', 'payment', 'adjustment')),
  external_reference TEXT,             -- AMS's own work-order/job reference for this line — never re-derived, just recorded
  amount            NUMERIC(14, 2) NOT NULL,
  previous_balance  NUMERIC(14, 2) NOT NULL,
  final_balance     NUMERIC(14, 2) NOT NULL,
  remarks           TEXT,
  created_by        UUID REFERENCES identities(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX operator_ledger_operator_idx ON operator_ledger (operator_identity_id, created_at);

CREATE TRIGGER operator_ledger_no_update
  BEFORE UPDATE ON operator_ledger
  -- Reuses audit_log_prevent_mutation() from migration 0007 — same
  -- reasoning as customer_ledger (0009) and artwork_versions (0012):
  -- fully generic despite the name, a prior migration's function isn't
  -- renamed after the fact.
  FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_mutation();

CREATE TRIGGER operator_ledger_no_delete
  BEFORE DELETE ON operator_ledger
  FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_mutation();
