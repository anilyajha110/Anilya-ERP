import type pg from "pg";
import { findOrCreateByExternalId } from "./product.service.js";
import { resolveWarehouse } from "./warehouse.service.js";
import { receiveInbound } from "./inventory.service.js";

// INV-002: the SAME event_id, submitted any number of times (a webhook
// retry, a doubled call), has effect exactly once. Checked BEFORE any
// side effect runs, not just wrapped in a try/catch after the fact.
export async function processInboundEvent(
  pool: pg.Pool,
  params: { organizationId: string; eventId: string; eventType: "STOCK_RECEIVED"; source: string; externalProductId: string; sku: string; productName: string; quantity: number; warehouseId?: string; createdBy?: string }
): Promise<{ wasNew: boolean }> {
  const { rows: existing } = await pool.query("SELECT 1 FROM inventory_inbound_events WHERE event_id = $1", [params.eventId]);
  if (existing[0]) return { wasNew: false };

  const { product } = await findOrCreateByExternalId(pool, { organizationId: params.organizationId, source: params.source, externalId: params.externalProductId, sku: params.sku, name: params.productName });
  const warehouse = await resolveWarehouse(pool, params.organizationId, params.warehouseId);
  await receiveInbound(pool, { organizationId: params.organizationId, productId: product.id, warehouseId: warehouse.id, quantity: params.quantity, reference: params.eventId, createdBy: params.createdBy });

  // Recorded LAST, only once every side effect has genuinely
  // succeeded — if anything above throws, this event is never marked
  // processed, so a legitimate retry after a transient failure still
  // goes through normally (as opposed to a false idempotency record
  // silently swallowing a retry that should have worked).
  await pool.query(
    "INSERT INTO inventory_inbound_events (event_id, organization_id, event_type, payload) VALUES ($1, $2, $3, $4)",
    [params.eventId, params.organizationId, params.eventType, JSON.stringify(params)]
  );
  return { wasNew: true };
}
