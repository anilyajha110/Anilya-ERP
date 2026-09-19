-- 0017_invoices: FIN-001. Extends orders.stage with 'delivered' — the
-- logistics stage Phase 4 deliberately left for a later phase to add
-- (it only went as far as 'completed', which means production work is
-- done, not that the customer has actually received the order).
-- Invoicing is gated on 'delivered' specifically, not 'completed' —
-- these are genuinely different real-world facts.
ALTER TABLE orders DROP CONSTRAINT orders_stage_check;
ALTER TABLE orders ADD CONSTRAINT orders_stage_check
  CHECK (stage IN ('imported', 'confirmed', 'in_progress', 'completed', 'delivered', 'cancelled'));

-- Orders had no price/amount field at all through Phases 4-8 — nothing
-- needed one yet. Invoicing is the first thing that genuinely does.
ALTER TABLE orders ADD COLUMN order_value NUMERIC(14, 2) NOT NULL DEFAULT 0;

-- One invoice per order, generated only once. The hard gate itself is
-- enforced in application code (invoice.service.ts) checking
-- orders.stage = 'delivered' — same "hard-blocked at every layer, not
-- just the UI" principle FIN-001 requires, and the same discipline as
-- Phase 5's print-ready gate: the check lives in the ONE function that
-- creates an invoice, not scattered across routes.
CREATE TABLE invoices (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  order_id         UUID NOT NULL UNIQUE REFERENCES orders(id),
  invoice_number   TEXT NOT NULL,
  amount           NUMERIC(14, 2) NOT NULL,
  generated_by     UUID REFERENCES identities(id),
  generated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX invoices_org_number_uq ON invoices (organization_id, invoice_number);

-- Per-organization, per-year invoice numbering — same race-condition-
-- safe row-locked counter pattern as order_number_counters (0011),
-- not a global sequence.
CREATE TABLE invoice_number_counters (
  organization_id UUID NOT NULL REFERENCES organizations(id),
  year            INT NOT NULL,
  last_number     INT NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, year)
);
