-- 0008_customer_profiles: CRM-specific data for identities where
-- identity_type = 'customer'. Deliberately a SEPARATE 1:1 table rather
-- than adding customer-only columns to `identities` itself — Staff and
-- Partner identities have no use for GSTIN or credit_limit, and mixing
-- concerns back into one table would recreate exactly the kind of
-- inconsistent shape Phase 2 fixed (RISK-012).
CREATE TABLE customer_profiles (
  identity_id       UUID PRIMARY KEY REFERENCES identities(id),
  status            TEXT NOT NULL DEFAULT 'dummy' CHECK (status IN ('dummy', 'active', 'blocked')),
  -- Structured billing chain (CRM-002): Name -> GSTIN -> Address -> City
  -- -> District -> State -> PIN, exactly as required — GSTIN flows
  -- through as a real field end-to-end, not bolted on at invoice time.
  billing_name      TEXT,
  gstin             TEXT,
  billing_address   TEXT,
  billing_city      TEXT,
  billing_district  TEXT,
  billing_state     TEXT,
  billing_pincode   TEXT,
  credit_limit      NUMERIC(12, 2) NOT NULL DEFAULT 0,
  payment_terms     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
