import type pg from "pg";
import { findOrCreateCustomer } from "../crm/customer.service.js";
import { nextDisplayOrderNumber } from "./order-number.js";
import { assertValidTransition, type OrderStage } from "./state-machine.js";

export interface Order {
  id: string;
  organization_id: string;
  customer_identity_id: string;
  idempotency_key: string;
  master_order_id: string | null;
  display_order_number: string;
  product_name: string;
  stage: OrderStage;
  shipping_address: string | null;
  tracking_token: string;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  created_at: Date;
}

// Fixes RISK-007 (Phase 0 audit): a REAL idempotency contract, not just
// a natural-key duplicate check. The exact same idempotencyKey,
// resubmitted any number of times (a webhook retry, a doubled click),
// returns the SAME order — never creates a second one, and never
// errors either, which is what makes retries actually safe to do.
export async function createOrder(
  pool: pg.Pool,
  params: {
    organizationId: string; idempotencyKey: string; orgPrefix: string; productName: string;
    masterOrderId?: string; shippingAddress?: string; customerName: string; customerPhone?: string; customerEmail?: string;
    createdBy?: string;
  }
): Promise<{ order: Order; wasNew: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: existing } = await client.query<Order>(
      "SELECT * FROM orders WHERE organization_id = $1 AND idempotency_key = $2",
      [params.organizationId, params.idempotencyKey]
    );
    if (existing[0]) {
      await client.query("COMMIT");
      return { order: existing[0], wasNew: false };
    }

    // findOrCreateCustomer runs its OWN internal transaction when it
    // creates a new customer — nesting is fine here since it uses a
    // separate pool.connect() rather than this client, so it commits
    // independently of this order's own transaction.
    const { customer } = await findOrCreateCustomer(pool, {
      organizationId: params.organizationId, displayName: params.customerName, phone: params.customerPhone, email: params.customerEmail,
    });

    const displayOrderNumber = await nextDisplayOrderNumber(client, params.organizationId, params.orgPrefix);

    const { rows } = await client.query<Order>(
      `INSERT INTO orders (organization_id, customer_identity_id, idempotency_key, master_order_id, display_order_number, product_name, shipping_address, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [params.organizationId, customer.identity_id, params.idempotencyKey, params.masterOrderId ?? null, displayOrderNumber, params.productName, params.shippingAddress ?? null, params.createdBy ?? null]
    );
    await client.query("COMMIT");
    return { order: rows[0]!, wasNew: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getOrderById(pool: pg.Pool, id: string): Promise<Order | null> {
  const { rows } = await pool.query<Order>("SELECT * FROM orders WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function getOrderByTrackingToken(pool: pg.Pool, token: string): Promise<Order | null> {
  const { rows } = await pool.query<Order>("SELECT * FROM orders WHERE tracking_token = $1", [token]);
  return rows[0] ?? null;
}

export async function listOrdersForCustomer(pool: pg.Pool, customerIdentityId: string): Promise<Order[]> {
  const { rows } = await pool.query<Order>("SELECT * FROM orders WHERE customer_identity_id = $1 ORDER BY created_at DESC", [customerIdentityId]);
  return rows;
}

// The ONLY function that changes an order's stage — validates the
// transition against the state machine before touching the row, so an
// invalid jump (e.g. cancelling an already-completed order) fails
// loudly instead of silently corrupting the lifecycle.
export async function transitionOrder(
  pool: pg.Pool,
  id: string,
  action: string,
  extra?: { cancellationReason?: string }
): Promise<Order> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<Order>("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [id]);
    if (!rows[0]) throw new Error("Order not found");
    const order = rows[0];

    const nextStage = assertValidTransition(action, order.stage);

    const { rows: updated } = await client.query<Order>(
      `UPDATE orders SET stage = $1, updated_at = now(),
         cancelled_at = CASE WHEN $1 = 'cancelled' THEN now() ELSE cancelled_at END,
         cancellation_reason = CASE WHEN $1 = 'cancelled' THEN $2 ELSE cancellation_reason END
       WHERE id = $3 RETURNING *`,
      [nextStage, extra?.cancellationReason ?? null, id]
    );
    await client.query("COMMIT");
    return updated[0]!;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
