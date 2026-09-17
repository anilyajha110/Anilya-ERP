import type pg from "pg";

export interface AuditEntry {
  organizationId: string;
  actorIdentityId?: string | null;
  actorRole?: string | null;
  actionType: string;
  entityType?: string | null;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  remarks?: string | null;
  ipAddress?: string | null;
  sessionId?: string | null;
}

// The ONE audit entry point for the whole system (fixes RISK-008 — the
// prototype ended up with four independent, non-unified audit tables).
// Every call here is a real-time INSERT — never batched, never deferred
// to logout — into a table the database itself refuses to UPDATE or
// DELETE (see migration 0007's trigger).
export async function logActivity(pool: pg.Pool, entry: AuditEntry): Promise<void> {
  await pool.query(
    `INSERT INTO audit_log
      (organization_id, actor_identity_id, actor_role, action_type, entity_type, entity_id, old_value, new_value, remarks, ip_address, session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      entry.organizationId,
      entry.actorIdentityId ?? null,
      entry.actorRole ?? null,
      entry.actionType,
      entry.entityType ?? null,
      entry.entityId ?? null,
      entry.oldValue != null ? JSON.stringify(entry.oldValue) : null,
      entry.newValue != null ? JSON.stringify(entry.newValue) : null,
      entry.remarks ?? null,
      entry.ipAddress ?? null,
      entry.sessionId ?? null,
    ]
  );
}
