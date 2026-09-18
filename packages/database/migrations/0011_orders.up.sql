-- 0011_orders: the core order entity. Scoped deliberately to Booking/
-- Orders alone per the blueprint's own phase ordering — Artwork,
-- Production, Logistics etc. each get their own later phase and will
-- extend `stage` with their own values, not be built into this table.
--
-- Fixes RISK-007 from the Phase 0 audit: the prototype's order import
-- was a direct-write endpoint with only a natural-key duplicate check
-- and no real idempotency contract. Here, `idempotency_key` is a
-- genuine, enforced uniqueness constraint per organization — replaying
-- the exact same import call (a real-world webhook retry, a doubled
-- click) returns the SAME order, never a duplicate.
CREATE TABLE orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id),
  customer_identity_id UUID NOT NULL REFERENCES identities(id),
  idempotency_key     TEXT NOT NULL,
  master_order_id     TEXT,             -- the Booking Portal's own grouping reference — pass-through, no logic depends on it
  display_order_number TEXT NOT NULL,
  product_name        TEXT NOT NULL,
  stage               TEXT NOT NULL DEFAULT 'imported'
                         CHECK (stage IN ('imported', 'confirmed', 'in_progress', 'completed', 'cancelled')),
  shipping_address    TEXT,
  tracking_token      UUID NOT NULL DEFAULT gen_random_uuid(),
  cancelled_at        TIMESTAMPTZ,
  cancellation_reason TEXT,
  created_by          UUID REFERENCES identities(id),   -- null = system/API import, not a staff action
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX orders_org_idempotency_uq ON orders (organization_id, idempotency_key);
CREATE UNIQUE INDEX orders_org_display_number_uq ON orders (organization_id, display_order_number);
CREATE UNIQUE INDEX orders_tracking_token_uq ON orders (tracking_token);
CREATE INDEX orders_customer_idx ON orders (customer_identity_id, created_at DESC);
CREATE INDEX orders_org_stage_idx ON orders (organization_id, stage);

-- Per-organization, per-month running counter for display order
-- numbers (ANILYA/2026/09/00001-style). A real table + row lock
-- (not a global Postgres SEQUENCE) because numbering must restart
-- per organization per month, and must never skip or collide under
-- concurrent inserts.
CREATE TABLE order_number_counters (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  year            INT NOT NULL,
  month           INT NOT NULL,
  last_number     INT NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, year, month)
);
