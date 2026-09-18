-- 0014_jobs: the core unit of production work against an order.
-- Scoped deliberately to job lifecycle + escalation + the two safety
-- rules with real teeth (JOB-002, JOB-004) — vendor rate approval
-- (JOB-005/006) and the Artwork Operator payment ledger (JOB-007) are
-- their own later phase, same discipline as splitting Gang Run out of
-- "Production" in Phase 6 rather than cramming everything in at once.
CREATE TABLE jobs (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           UUID NOT NULL REFERENCES organizations(id),
  order_id                  UUID NOT NULL REFERENCES orders(id),
  job_type                  TEXT NOT NULL CHECK (job_type IN ('fixed', 'extra')),
  description               TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'in_progress', 'completed', 'cancelled')),
  assigned_partner_identity_id UUID REFERENCES identities(id),
  created_by                UUID REFERENCES identities(id),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_at               TIMESTAMPTZ,
  started_at                TIMESTAMPTZ,
  completed_at               TIMESTAMPTZ
);

CREATE INDEX jobs_order_idx ON jobs (order_id);
CREATE INDEX jobs_org_status_idx ON jobs (organization_id, status);
CREATE INDEX jobs_partner_idx ON jobs (assigned_partner_identity_id);

-- JOB-003: 5 named escalation triggers, each job escalated at most once
-- while unresolved — a genuinely queryable queue for Managers, not just
-- an implicit "someone will notice eventually."
CREATE TABLE job_escalations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES jobs(id),
  trigger_reason  TEXT NOT NULL CHECK (trigger_reason IN ('no_supervisor_online', 'never_assigned', 'timeout', 'rejected', 'emergency')),
  escalated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  escalated_by    UUID REFERENCES identities(id),
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID REFERENCES identities(id),
  resolution_note TEXT
);

CREATE INDEX job_escalations_job_idx ON job_escalations (job_id);
-- At most one UNRESOLVED escalation per job at a time — a second
-- trigger firing on an already-escalated job should update/resolve the
-- existing one, not spawn a parallel queue entry for the same job.
CREATE UNIQUE INDEX job_escalations_one_open_per_job ON job_escalations (job_id) WHERE resolved_at IS NULL;
