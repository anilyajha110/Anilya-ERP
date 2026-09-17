-- 0004_rbac: ONE permission model for every identity type. In the
-- prototype, Staff had a flat `role` string while Partners had a
-- separate many-to-many `capability_types` table — genuinely different
-- shapes for the same underlying idea. Here, everyone (Staff, Partner,
-- Customer) gets roles the same way: via identity_roles. A Partner who
-- is both a Printer and a Binder simply has two roles, same mechanism
-- a Staff member's single role uses.

-- The catalog of things that CAN be permitted — organization-independent.
-- Which roles grant which permission is what varies per organization.
CREATE TABLE permissions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT NOT NULL UNIQUE,   -- e.g. 'orders.create', 'complaints.resolve', 'audit.report.read'
  description TEXT NOT NULL
);

-- Roles are org-scoped: each organization defines its own named roles,
-- even though the underlying permission catalog is shared.
CREATE TABLE roles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name            TEXT NOT NULL,      -- e.g. 'Manager', 'Printer', 'Support Executive'
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);

CREATE TABLE role_permissions (
  role_id       UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- One identity can hold multiple roles (a Partner who is both Printer
-- and Binder; a Staff member temporarily covering two functions).
CREATE TABLE identity_roles (
  identity_id UUID NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  role_id     UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by  UUID REFERENCES identities(id),   -- who assigned this role — audit-relevant, not just informational
  PRIMARY KEY (identity_id, role_id)
);

CREATE INDEX identity_roles_identity_idx ON identity_roles (identity_id);
