-- 0019_parcels: LOG-001/002. Gives the order lifecycle real
-- Dispatched/Out-for-Delivery granularity between 'completed' and
-- 'delivered' — Phase 9 deliberately left that as one direct step
-- since Finance only needed the endpoints (delivered), not the
-- journey. Both paths stay valid: a small order can still go straight
-- 'completed' -> 'delivered' (in-person pickup, no logistics
-- tracking needed); a parcelled order goes through the full journey.
ALTER TABLE orders DROP CONSTRAINT orders_stage_check;
ALTER TABLE orders ADD CONSTRAINT orders_stage_check
  CHECK (stage IN ('imported', 'confirmed', 'in_progress', 'completed', 'dispatched', 'out_for_delivery', 'delivered', 'cancelled'));

-- LOG-001: bundling multiple orders into one physical parcel for
-- dispatch. Cascading status to every member order lives in
-- application code (parcel.service.ts) — the ONE place that walks
-- parcel_orders and calls transitionOrder() for each member, so every
-- normal order-lifecycle rule (state machine validation, audit
-- logging) still applies per-order, not bypassed for parcel members.
CREATE TABLE parcels (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id),
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dispatched', 'out_for_delivery', 'delivered')),
  courier_reference TEXT,
  created_by        UUID REFERENCES identities(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at     TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ
);

-- LOG-002: an order belongs to AT MOST ONE parcel at a time (the
-- UNIQUE on order_id) — splitting an order out (DELETE this row) is
-- exactly what lets it proceed independently afterward, unaffected by
-- whatever happens to the rest of the parcel from then on.
CREATE TABLE parcel_orders (
  parcel_id  UUID NOT NULL REFERENCES parcels(id),
  order_id   UUID NOT NULL UNIQUE REFERENCES orders(id),
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (parcel_id, order_id)
);

CREATE INDEX parcels_org_status_idx ON parcels (organization_id, status);
