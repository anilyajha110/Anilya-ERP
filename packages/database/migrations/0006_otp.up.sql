-- 0006_otp: centralized OTP service, one design used by every login
-- method and every identity type. The code itself is NEVER stored —
-- only its hash, from the very first migration, not retrofitted later.
-- One otp_request_id can fan out to multiple delivery channels (SMS/
-- WhatsApp/Email), each tracked independently — this was a genuinely
-- good pattern from the prototype, carried forward deliberately.
CREATE TABLE otp_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id     UUID NOT NULL REFERENCES identities(id),
  purpose         TEXT NOT NULL DEFAULT 'login',
  otp_hash        TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  attempts        INT NOT NULL DEFAULT 0,
  max_attempts    INT NOT NULL DEFAULT 3,
  verified_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE otp_channel_deliveries (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  otp_request_id     UUID NOT NULL REFERENCES otp_requests(id) ON DELETE CASCADE,
  channel            TEXT NOT NULL CHECK (channel IN ('sms', 'whatsapp', 'email')),
  destination_masked TEXT,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'failed')),
  provider_reference TEXT,
  sent_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  status_updated_at  TIMESTAMPTZ
);

CREATE INDEX otp_requests_identity_idx ON otp_requests (identity_id, created_at DESC);

-- Now that otp_requests exists, complete the FK deferred from 0005.
ALTER TABLE sessions ADD CONSTRAINT sessions_otp_request_fk
  FOREIGN KEY (otp_request_id) REFERENCES otp_requests(id);
