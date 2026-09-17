-- 0005_sessions: ONE session table for every identity type — fixes a
-- real problem hit while building the prototype: a Partner-only foreign
-- key on the original sessions table meant Customer and Artwork
-- Operator logins each needed their own separate table just to satisfy
-- the FK. With one unified `identities` table (0003), one sessions
-- table works for everyone.
--
-- The session token itself is hashed (SHA-256), never stored raw — the
-- same principle already applied to OTPs and API keys in the
-- prototype, applied consistently here from the start rather than
-- added after a security audit found it missing.
CREATE TABLE sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id       UUID NOT NULL REFERENCES identities(id),
  token_hash        TEXT NOT NULL UNIQUE,
  login_method      TEXT NOT NULL CHECK (login_method IN ('password', 'otp', 'password_otp')),
  otp_request_id    UUID,             -- set only when OTP was part of this login; FK added in 0006 once otp_requests exists
  ip_address        INET,
  device_info       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  revoked_at        TIMESTAMPTZ       -- explicit revocation (logout), distinct from natural expiry — both make a session invalid, but audit needs to tell them apart
);

CREATE INDEX sessions_identity_idx ON sessions (identity_id);
-- Fast "is this session currently valid" lookups without a full table scan.
CREATE INDEX sessions_active_idx ON sessions (token_hash) WHERE revoked_at IS NULL;
