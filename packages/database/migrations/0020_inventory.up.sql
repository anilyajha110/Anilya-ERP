-- 0020_inventory: kept as its own isolated module — mirrors the
-- original prototype's own Inventory Phase 1 scoping — rather than
-- woven directly into orders/jobs. Deliberately scoped tight to the
-- safety-critical core (INV-001 through 004, and a real fix for
-- INV-008): concurrency-safe reservation, idempotent event ingestion,
-- an atomic ledger+snapshot, and deterministic warehouse resolution.
-- The Outbox/dead-letter retry infrastructure (INV-005), the full
-- Zone/City/Godown RBAC hierarchy (INV-006), bulk supplier mapping
-- (INV-007), and PO/GRN/Transfer/Consignment/Batch/Cycle-Count
-- (INV-009) are all deliberately deferred to their own later phase —
-- same discipline as every phase boundary so far.

CREATE TABLE inventory_products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  sku             TEXT NOT NULL,
  name            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, sku)
);

-- INV-001: external-ID mapping, scoped by (organization, source) —
-- the same external id from two different SOURCES (a Booking Portal
-- vs. a Supplier system) never collides, and the same external id
-- reused in a different organization is a completely separate mapping.
CREATE TABLE inventory_product_external_map (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  product_id      UUID NOT NULL REFERENCES inventory_products(id),
  source          TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, source, external_id)
);

-- INV-008 fix: a REAL, deterministic default-warehouse strategy — the
-- prototype's own fallback was "whichever warehouse happens to be
-- first in the table," an accident of insertion order, not a decision.
-- Here, at most ONE warehouse per organization may be marked default
-- (enforced by the partial unique index below), and resolution
-- (inventory.service.ts) fails loudly if a reservation needs one and
-- none is configured, rather than silently guessing.
CREATE TABLE inventory_warehouses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name            TEXT NOT NULL,
  city            TEXT,
  is_default      BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX inventory_warehouses_one_default_per_org ON inventory_warehouses (organization_id) WHERE is_default = true;

-- on_hand = physical stock actually in the warehouse.
-- reserved  = held against active reservations, not yet consumed.
-- available = on_hand - reserved, computed at read time, never stored
-- (a stored/cached "available" column could drift from truth; deriving
-- it from the two real numbers every time cannot).
CREATE TABLE inventory_stock (
  warehouse_id UUID NOT NULL REFERENCES inventory_warehouses(id),
  product_id   UUID NOT NULL REFERENCES inventory_products(id),
  on_hand      INT NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved     INT NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (warehouse_id, product_id),
  -- The single most important invariant in this whole module: never
  -- reserve more than is actually on hand. A database-level CHECK, not
  -- just application discipline — the same defense-in-depth as
  -- customer_ledger's balance-formula constraint (Phase 3).
  CONSTRAINT inventory_stock_reserved_le_on_hand CHECK (reserved <= on_hand)
);

-- INV-003: one row per reservation, so a partial release/consume is
-- possible without ambiguity about which reservation it belongs to.
CREATE TABLE inventory_reservations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  product_id      UUID NOT NULL REFERENCES inventory_products(id),
  warehouse_id    UUID NOT NULL REFERENCES inventory_warehouses(id),
  order_id        UUID REFERENCES orders(id),
  quantity        INT NOT NULL CHECK (quantity > 0),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'consumed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ
);

CREATE INDEX inventory_reservations_product_warehouse_idx ON inventory_reservations (product_id, warehouse_id);
CREATE INDEX inventory_reservations_order_idx ON inventory_reservations (order_id);

-- INV-004: atomic ledger + snapshot. Append-only (same genuine
-- trigger-enforced immutability as every other ledger in this
-- project), previous/new on_hand snapshotted on every single movement
-- so the full history is independently reconstructable, never just
-- trusted from the current inventory_stock row alone.
CREATE TABLE inventory_ledger (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id   UUID NOT NULL REFERENCES organizations(id),
  product_id        UUID NOT NULL REFERENCES inventory_products(id),
  warehouse_id      UUID NOT NULL REFERENCES inventory_warehouses(id),
  movement_type     TEXT NOT NULL CHECK (movement_type IN ('inbound', 'reserve', 'release', 'consume', 'adjustment')),
  quantity          INT NOT NULL,
  previous_on_hand  INT NOT NULL,
  new_on_hand       INT NOT NULL,
  reference         TEXT,
  created_by        UUID REFERENCES identities(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX inventory_ledger_product_warehouse_idx ON inventory_ledger (product_id, warehouse_id, created_at);

CREATE TRIGGER inventory_ledger_no_update
  BEFORE UPDATE ON inventory_ledger
  FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_mutation();

CREATE TRIGGER inventory_ledger_no_delete
  BEFORE DELETE ON inventory_ledger
  FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_mutation();

-- INV-002: idempotent inbound events — event_id is the whole point,
-- replaying the exact same event any number of times has no further
-- effect after the first, the same principle as Orders'
-- idempotencyKey (Phase 4) and the Operator Ledger's externalReference (Phase 8).
CREATE TABLE inventory_inbound_events (
  event_id        TEXT PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id),
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
