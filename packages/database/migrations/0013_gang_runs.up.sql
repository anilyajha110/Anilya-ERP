-- 0013_gang_runs: combining multiple orders' printing into one shared
-- physical run. Scoped to just the pooling mechanism and its one
-- non-negotiable safety rule (ART-004/ART-005) — a full Job/Production
-- engine (JOB-001 through JOB-007: job lifecycle, escalation, vendor
-- rates) is its own later phase, not folded in here.
--
-- ART-004: an order may join a Gang Run ONLY if it is ALREADY
-- individually print-ready (Phase 5's order_artwork.print_ready).
-- Gang Run combination is a THIRD tier layered on top of that
-- individual approval, never a substitute for it — enforced in
-- gang-run.service.ts, not just documented here.
CREATE TABLE gang_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- doubles as the "Shadow Job ID" / temporary_gang_run_id referenced elsewhere
  organization_id UUID NOT NULL REFERENCES organizations(id),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  created_by      UUID REFERENCES identities(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ
);

-- ART-005: full audit trail preserved even after the shadow ID
-- "closes" — member rows are never deleted, only the parent gang_run's
-- status changes. An order may belong to at most one gang run, ever
-- (UNIQUE on order_id alone, not per-gang-run) — once gang-printed, an
-- order doesn't get pooled a second time.
CREATE TABLE gang_run_members (
  gang_run_id UUID NOT NULL REFERENCES gang_runs(id),
  order_id    UUID NOT NULL UNIQUE REFERENCES orders(id),
  added_by    UUID REFERENCES identities(id),
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (gang_run_id, order_id)
);

CREATE INDEX gang_run_members_gang_run_idx ON gang_run_members (gang_run_id);
