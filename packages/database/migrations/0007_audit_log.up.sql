-- 0007_audit_log: ONE audit mechanism for the entire system — fixes
-- RISK-008 from the Phase 0 audit, where the prototype ended up with
-- FOUR independent audit tables (general, complaint-specific, rate-
-- specific, and a separate one inside the Inventory module) because
-- each feature pass added its own rather than reusing one designed
-- primitive.
--
-- Immutability this time is enforced by the DATABASE ITSELF via a
-- trigger that rejects UPDATE/DELETE outright — not "immutable because
-- no application code happens to update it," which was the prototype's
-- actual (weaker) guarantee. This is something Postgres can do that
-- SQLite could not.
CREATE TABLE audit_log (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  actor_identity_id UUID REFERENCES identities(id),    -- null = system-initiated action
  actor_role       TEXT,                                -- role label AT THE TIME of the action (roles can change later; this is a point-in-time record)
  action_type      TEXT NOT NULL,                        -- e.g. 'identity.login', 'identity.logout', 'role.granted'
  entity_type      TEXT,                                 -- e.g. 'identity', 'session', 'role' — generic on purpose; business-domain modules (Orders, etc.) reuse this same table in later phases
  entity_id        UUID,
  old_value         JSONB,
  new_value         JSONB,
  remarks           TEXT,
  ip_address        INET,
  session_id        UUID REFERENCES sessions(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_org_idx ON audit_log (organization_id, created_at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_identity_id, created_at DESC);
CREATE INDEX audit_log_session_idx ON audit_log (session_id);

-- Genuine, database-enforced immutability: any UPDATE or DELETE attempt
-- against this table fails, regardless of which role or application
-- code issues it. A correction is always a NEW row, never an edit.
CREATE FUNCTION audit_log_prevent_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted on this table', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_mutation();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_mutation();
