-- 0002_organizations: the multi-tenant boundary the Phase 0 audit found
-- completely missing (RISK-001). Built in NOW, before any identity or
-- business data exists, specifically because retrofitting a tenant
-- column onto populated tables later is far more dangerous than having
-- it from the start.
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- provides gen_random_uuid()

CREATE TABLE organizations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,   -- URL-safe identifier, e.g. for subdomains later
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every future tenant-scoped table in this system references this one.
-- Enforced by foreign key, not convention.
