-- 0010_import_batches: CRM-004 from the Phase 0 audit — the prototype's
-- Booking Portal import was a direct insert with no preview, no
-- dry-run, and no rollback path. This tracks every import as a batch,
-- recording per-row whether it matched an EXISTING customer or created
-- a NEW one — rollback can then safely delete only the customers this
-- batch itself created, and must never touch a customer that already
-- existed before the import ran.
CREATE TABLE import_batches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  created_by      UUID REFERENCES identities(id),
  status          TEXT NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'committed', 'rolled_back')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at    TIMESTAMPTZ,
  rolled_back_at  TIMESTAMPTZ
);

CREATE TABLE import_batch_entries (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id            UUID NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_number          INT NOT NULL,
  input_name          TEXT,
  input_phone         TEXT,
  input_email         TEXT,
  -- ON DELETE SET NULL (not the default RESTRICT): if a customer this
  -- row created is later actually deleted (e.g. a second, harder cleanup
  -- after rollback), this historical row survives as the audit record
  -- of what happened — it just loses the now-dangling reference. Found
  -- live: rollbackImport() deleting the identity failed outright against
  -- the default RESTRICT behavior, since this row still pointed at it.
  matched_identity_id UUID REFERENCES identities(id) ON DELETE SET NULL,   -- set when this row resolved to a PRE-EXISTING customer
  created_identity_id UUID REFERENCES identities(id) ON DELETE SET NULL,   -- set only when this row created a genuinely NEW customer
  was_new_customer    BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX import_batch_entries_batch_idx ON import_batch_entries (batch_id);
