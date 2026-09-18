-- 0015_vendor_rates: JOB-005/006. A quote at or under the reference
-- rate is auto-accepted; above it, a Manager must approve. Approving
-- one high quote must NEVER silently move the reference rate itself —
-- that's a deliberate, separate, explicit action, or a one-off
-- exception for a single vendor's single job would quietly become the
-- new baseline for every future quote.
CREATE TABLE vendor_master_rates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  category        TEXT NOT NULL,             -- e.g. 'lamination', 'binding' — whatever the job_type/description scheme this org uses
  reference_rate  NUMERIC(14, 2) NOT NULL,
  updated_by      UUID REFERENCES identities(id),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, category)
);

CREATE TABLE vendor_rate_quotes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES organizations(id),
  job_id                UUID NOT NULL REFERENCES jobs(id),
  partner_identity_id   UUID NOT NULL REFERENCES identities(id),
  quoted_rate           NUMERIC(14, 2) NOT NULL,
  -- Snapshotted at quote time, deliberately never re-read from
  -- vendor_master_rates later — if the master rate changes afterward,
  -- this quote's own accept/reject decision must stay explainable
  -- against what was actually true when it was made.
  reference_rate_at_quote NUMERIC(14, 2) NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('auto_accepted', 'pending_approval', 'approved', 'rejected')),
  approved_by           UUID REFERENCES identities(id),
  approved_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX vendor_rate_quotes_job_idx ON vendor_rate_quotes (job_id);
CREATE INDEX vendor_rate_quotes_org_status_idx ON vendor_rate_quotes (organization_id, status);
