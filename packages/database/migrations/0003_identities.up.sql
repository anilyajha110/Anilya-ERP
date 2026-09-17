-- 0003_identities: ONE identity shape for every actor in the system —
-- Staff, Partner (Printer/Binder/Supplier/Processor/Courier/Artwork
-- Operator), and Customer. This directly fixes RISK-012 from the Phase
-- 0 audit: the prototype had a flat role enum for Staff but a separate
-- many-to-many capability model for Partners, and building Customer/
-- Operator login later forced THREE separate session tables because
-- a shared table's foreign key pointed at Partners only. A single
-- identity table with a `identity_type` discriminator avoids all of
-- that — RBAC (0004) and sessions (0005) each reference this one table.
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE identities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  identity_type   TEXT NOT NULL CHECK (identity_type IN ('staff', 'partner', 'customer')),
  display_name    TEXT NOT NULL,
  email           CITEXT,           -- case-insensitive, so Foo@x.com and foo@x.com are the same account
  phone            TEXT,
  password_hash   TEXT,             -- nullable: an OTP-only identity (Customer, some Partners) may never set one
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Within one organization, the same email or phone can't register twice
-- — but the SAME email/phone CAN exist in two different organizations
-- (multi-tenant isolation, not a global uniqueness rule).
CREATE UNIQUE INDEX identities_org_email_uq ON identities (organization_id, email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX identities_org_phone_uq ON identities (organization_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX identities_org_type_idx ON identities (organization_id, identity_type);
