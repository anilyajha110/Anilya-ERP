-- 0021_notifications: LOG-003. A type x recipient-role -> channel(s)
-- routing matrix. The single rule that matters: changing a routing
-- rule tomorrow must NEVER retroactively change what a notification
-- sent yesterday actually did. Achieved by SNAPSHOTTING the resolved
-- channels onto each notification at send time (notifications.channels_snapshot)
-- rather than that notification holding a live reference to the rule —
-- the same "snapshot, don't live-reference" principle already used for
-- vendor_rate_quotes.reference_rate_at_quote (Phase 8).

CREATE TABLE notification_types (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  key             TEXT NOT NULL,           -- e.g. 'order.delivered', 'complaint.resolved', 'invoice.generated'
  description     TEXT NOT NULL,
  UNIQUE (organization_id, key)
);

-- The matrix itself: for THIS type, THIS recipient role gets notified
-- via THESE channels. Multiple channels per (type, role) via multiple
-- rows, not an array column — makes "does SMS routing exist for X"
-- a plain WHERE, not an array-containment query.
CREATE TABLE notification_routing_rules (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id),
  notification_type_id UUID NOT NULL REFERENCES notification_types(id),
  recipient_role      TEXT NOT NULL,       -- 'customer' | 'staff' | a specific role name — deliberately just a string, not an FK to roles, since a rule can target a broad audience a single role row can't express
  channel             TEXT NOT NULL CHECK (channel IN ('sms', 'whatsapp', 'email', 'in_app')),
  active              BOOLEAN NOT NULL DEFAULT true,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, notification_type_id, recipient_role, channel)
);

-- One row per notification actually triggered. channels_snapshot is
-- the list of channels THIS notification used — resolved from the
-- routing rules at the moment it was created, then frozen. Append-only
-- (same genuine trigger-enforced immutability as every other
-- history-bearing table in this project) — a notification, once sent,
-- is a historical fact, never edited.
CREATE TABLE notifications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id),
  notification_type_id UUID NOT NULL REFERENCES notification_types(id),
  recipient_identity_id UUID NOT NULL REFERENCES identities(id),
  entity_type         TEXT,                -- e.g. 'order', 'complaint_ticket' — what this notification is ABOUT
  entity_id           UUID,
  channels_snapshot   TEXT[] NOT NULL,     -- frozen at creation — e.g. {sms,email}
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX notifications_recipient_idx ON notifications (recipient_identity_id, created_at DESC);

CREATE TRIGGER notifications_no_update
  BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_mutation();

CREATE TRIGGER notifications_no_delete
  BEFORE DELETE ON notifications
  FOR EACH ROW EXECUTE FUNCTION audit_log_prevent_mutation();

-- Per-channel delivery tracking — same fan-out pattern already used
-- for OTP (otp_channel_deliveries, Phase 2/9): one notification can
-- genuinely go out on more than one channel, each tracked independently.
CREATE TABLE notification_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES notifications(id),
  channel         TEXT NOT NULL CHECK (channel IN ('sms', 'whatsapp', 'email', 'in_app')),
  status          TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('pending', 'sent', 'delivered', 'failed')),
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX notification_deliveries_notification_idx ON notification_deliveries (notification_id);
