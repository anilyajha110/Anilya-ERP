import type pg from "pg";

export interface NotificationType {
  id: string;
  organization_id: string;
  key: string;
  description: string;
}
export interface Notification {
  id: string;
  organization_id: string;
  notification_type_id: string;
  recipient_identity_id: string;
  entity_type: string | null;
  entity_id: string | null;
  channels_snapshot: string[];
  created_at: Date;
}

export class NoRoutingRuleError extends Error {
  constructor(typeKey: string, role: string) { super(`No active routing rule for notification type '${typeKey}' and recipient role '${role}' — nothing would be sent`); this.name = "NoRoutingRuleError"; }
}

export async function createNotificationType(pool: pg.Pool, params: { organizationId: string; key: string; description: string }): Promise<NotificationType> {
  const { rows } = await pool.query<NotificationType>(
    "INSERT INTO notification_types (organization_id, key, description) VALUES ($1, $2, $3) RETURNING *",
    [params.organizationId, params.key, params.description]
  );
  return rows[0]!;
}

// The routing matrix itself — set/unset one (type, role, channel) cell
// at a time. Setting the SAME cell twice is a safe no-op (ON CONFLICT),
// never a duplicate row silently doubling a channel's delivery.
export async function setRoutingRule(pool: pg.Pool, params: { organizationId: string; notificationTypeId: string; recipientRole: string; channel: "sms" | "whatsapp" | "email" | "in_app" }): Promise<void> {
  await pool.query(
    `INSERT INTO notification_routing_rules (organization_id, notification_type_id, recipient_role, channel, active) VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (organization_id, notification_type_id, recipient_role, channel) DO UPDATE SET active = true, updated_at = now()`,
    [params.organizationId, params.notificationTypeId, params.recipientRole, params.channel]
  );
}

export async function removeRoutingRule(pool: pg.Pool, params: { organizationId: string; notificationTypeId: string; recipientRole: string; channel: string }): Promise<void> {
  // Deactivated, not deleted — the rule's own history (when it was
  // active, when it stopped) is itself worth keeping, same reasoning
  // as everywhere else in this project that prefers a status flag over
  // a hard delete.
  await pool.query(
    "UPDATE notification_routing_rules SET active = false, updated_at = now() WHERE organization_id = $1 AND notification_type_id = $2 AND recipient_role = $3 AND channel = $4",
    [params.organizationId, params.notificationTypeId, params.recipientRole, params.channel]
  );
}

export async function getActiveChannels(pool: pg.Pool, organizationId: string, notificationTypeId: string, recipientRole: string): Promise<string[]> {
  const { rows } = await pool.query<{ channel: string }>(
    "SELECT channel FROM notification_routing_rules WHERE organization_id = $1 AND notification_type_id = $2 AND recipient_role = $3 AND active = true",
    [organizationId, notificationTypeId, recipientRole]
  );
  return rows.map((r) => r.channel);
}

// LOG-003 — the single most important function in this module.
// Resolves the CURRENT routing rule at the moment of calling, then
// freezes the result onto the notification row itself
// (channels_snapshot). A routing rule changed an hour from now has
// zero effect on what this notification already recorded as having done.
export async function notify(
  pool: pg.Pool,
  params: { organizationId: string; typeKey: string; recipientIdentityId: string; recipientRole: string; entityType?: string; entityId?: string }
): Promise<Notification> {
  const { rows: typeRows } = await pool.query<NotificationType>("SELECT * FROM notification_types WHERE organization_id = $1 AND key = $2", [params.organizationId, params.typeKey]);
  if (!typeRows[0]) throw new Error(`Unknown notification type: ${params.typeKey}`);
  const notificationType = typeRows[0];

  const channels = await getActiveChannels(pool, params.organizationId, notificationType.id, params.recipientRole);
  if (channels.length === 0) throw new NoRoutingRuleError(params.typeKey, params.recipientRole);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<Notification>(
      `INSERT INTO notifications (organization_id, notification_type_id, recipient_identity_id, entity_type, entity_id, channels_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [params.organizationId, notificationType.id, params.recipientIdentityId, params.entityType ?? null, params.entityId ?? null, channels]
    );
    const notification = rows[0]!;
    for (const channel of channels) {
      await client.query("INSERT INTO notification_deliveries (notification_id, channel, status) VALUES ($1, $2, 'sent')", [notification.id, channel]);
    }
    await client.query("COMMIT");
    return notification;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getNotificationById(pool: pg.Pool, id: string): Promise<Notification | null> {
  const { rows } = await pool.query<Notification>("SELECT * FROM notifications WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function listNotificationsForRecipient(pool: pg.Pool, recipientIdentityId: string): Promise<Notification[]> {
  const { rows } = await pool.query<Notification>("SELECT * FROM notifications WHERE recipient_identity_id = $1 ORDER BY created_at DESC", [recipientIdentityId]);
  return rows;
}
