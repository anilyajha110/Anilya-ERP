import type pg from "pg";

export interface Reservation {
  id: string;
  product_id: string;
  warehouse_id: string;
  order_id: string | null;
  quantity: number;
  status: "active" | "released" | "consumed";
}

export class InsufficientStockError extends Error {
  constructor(available: number, requested: number) { super(`Only ${available} unit(s) available, ${requested} requested`); this.name = "InsufficientStockError"; }
}
export class ReservationNotActiveError extends Error {
  constructor(status: string) { super(`Cannot act on a reservation in status '${status}' — only 'active' reservations can be released or consumed`); this.name = "ReservationNotActiveError"; }
}

async function writeLedgerEntry(
  client: pg.PoolClient,
  params: { organizationId: string; productId: string; warehouseId: string; movementType: "inbound" | "reserve" | "release" | "consume" | "adjustment"; quantity: number; previousOnHand: number; newOnHand: number; reference?: string; createdBy?: string }
) {
  await client.query(
    `INSERT INTO inventory_ledger (organization_id, product_id, warehouse_id, movement_type, quantity, previous_on_hand, new_on_hand, reference, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [params.organizationId, params.productId, params.warehouseId, params.movementType, params.quantity, params.previousOnHand, params.newOnHand, params.reference ?? null, params.createdBy ?? null]
  );
}

async function ensureStockRow(client: pg.PoolClient, productId: string, warehouseId: string) {
  await client.query(
    "INSERT INTO inventory_stock (warehouse_id, product_id, on_hand, reserved) VALUES ($1, $2, 0, 0) ON CONFLICT DO NOTHING",
    [warehouseId, productId]
  );
}

// INV-004: on_hand increases, ledger + snapshot written in the SAME
// transaction — never one without the other.
export async function receiveInbound(
  pool: pg.Pool,
  params: { organizationId: string; productId: string; warehouseId: string; quantity: number; reference?: string; createdBy?: string }
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureStockRow(client, params.productId, params.warehouseId);
    const { rows: before } = await client.query<{ on_hand: number }>(
      "SELECT on_hand FROM inventory_stock WHERE warehouse_id = $1 AND product_id = $2 FOR UPDATE", [params.warehouseId, params.productId]
    );
    const previousOnHand = before[0]!.on_hand;
    const newOnHand = previousOnHand + params.quantity;
    await client.query("UPDATE inventory_stock SET on_hand = $1, updated_at = now() WHERE warehouse_id = $2 AND product_id = $3", [newOnHand, params.warehouseId, params.productId]);
    await writeLedgerEntry(client, { ...params, movementType: "inbound", previousOnHand, newOnHand });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// INV-003 — the single most safety-critical function in this module.
// FOR UPDATE locks the stock row for the duration of this transaction,
// so two concurrent reservation attempts against the same product/
// warehouse can never both read the same "available" number and both
// succeed when only one of them actually fits — the database itself
// (reserved <= on_hand, migration 0020) is the final backstop even if
// this logic were ever wrong.
export async function reserveStock(
  pool: pg.Pool,
  params: { organizationId: string; productId: string; warehouseId: string; orderId?: string; quantity: number; createdBy?: string }
): Promise<Reservation> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureStockRow(client, params.productId, params.warehouseId);
    const { rows: stockRows } = await client.query<{ on_hand: number; reserved: number }>(
      "SELECT on_hand, reserved FROM inventory_stock WHERE warehouse_id = $1 AND product_id = $2 FOR UPDATE",
      [params.warehouseId, params.productId]
    );
    const { on_hand, reserved } = stockRows[0]!;
    const available = on_hand - reserved;
    if (available < params.quantity) throw new InsufficientStockError(available, params.quantity);

    const newReserved = reserved + params.quantity;
    await client.query("UPDATE inventory_stock SET reserved = $1, updated_at = now() WHERE warehouse_id = $2 AND product_id = $3", [newReserved, params.warehouseId, params.productId]);

    const { rows: reservationRows } = await client.query<Reservation>(
      "INSERT INTO inventory_reservations (organization_id, product_id, warehouse_id, order_id, quantity) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [params.organizationId, params.productId, params.warehouseId, params.orderId ?? null, params.quantity]
    );
    await writeLedgerEntry(client, { ...params, movementType: "reserve", previousOnHand: on_hand, newOnHand: on_hand, reference: reservationRows[0]!.id });
    await client.query("COMMIT");
    return reservationRows[0]!;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function releaseReservation(pool: pg.Pool, reservationId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: resRows } = await client.query<Reservation & { organization_id: string }>("SELECT * FROM inventory_reservations WHERE id = $1 FOR UPDATE", [reservationId]);
    if (!resRows[0]) throw new Error("Reservation not found");
    if (resRows[0].status !== "active") throw new ReservationNotActiveError(resRows[0].status);
    const r = resRows[0];

    const { rows: stockRows } = await client.query<{ on_hand: number; reserved: number }>(
      "SELECT on_hand, reserved FROM inventory_stock WHERE warehouse_id = $1 AND product_id = $2 FOR UPDATE", [r.warehouse_id, r.product_id]
    );
    await client.query("UPDATE inventory_stock SET reserved = reserved - $1, updated_at = now() WHERE warehouse_id = $2 AND product_id = $3", [r.quantity, r.warehouse_id, r.product_id]);
    await client.query("UPDATE inventory_reservations SET status = 'released', resolved_at = now() WHERE id = $1", [reservationId]);
    await writeLedgerEntry(client, { organizationId: r.organization_id, productId: r.product_id, warehouseId: r.warehouse_id, movementType: "release", quantity: r.quantity, previousOnHand: stockRows[0]!.on_hand, newOnHand: stockRows[0]!.on_hand, reference: reservationId });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Consuming a reservation is what actually removes stock physically —
// on_hand AND reserved both decrease together, in the same transaction.
export async function consumeReservation(pool: pg.Pool, reservationId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: resRows } = await client.query<Reservation & { organization_id: string }>("SELECT * FROM inventory_reservations WHERE id = $1 FOR UPDATE", [reservationId]);
    if (!resRows[0]) throw new Error("Reservation not found");
    if (resRows[0].status !== "active") throw new ReservationNotActiveError(resRows[0].status);
    const r = resRows[0];

    const { rows: stockRows } = await client.query<{ on_hand: number; reserved: number }>(
      "SELECT on_hand, reserved FROM inventory_stock WHERE warehouse_id = $1 AND product_id = $2 FOR UPDATE", [r.warehouse_id, r.product_id]
    );
    const previousOnHand = stockRows[0]!.on_hand;
    const newOnHand = previousOnHand - r.quantity;
    await client.query("UPDATE inventory_stock SET on_hand = $1, reserved = reserved - $2, updated_at = now() WHERE warehouse_id = $3 AND product_id = $4", [newOnHand, r.quantity, r.warehouse_id, r.product_id]);
    await client.query("UPDATE inventory_reservations SET status = 'consumed', resolved_at = now() WHERE id = $1", [reservationId]);
    await writeLedgerEntry(client, { organizationId: r.organization_id, productId: r.product_id, warehouseId: r.warehouse_id, movementType: "consume", quantity: r.quantity, previousOnHand, newOnHand, reference: reservationId });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getStock(pool: pg.Pool, productId: string, warehouseId: string) {
  const { rows } = await pool.query<{ on_hand: number; reserved: number }>(
    "SELECT on_hand, reserved FROM inventory_stock WHERE warehouse_id = $1 AND product_id = $2", [warehouseId, productId]
  );
  const stock = rows[0] ?? { on_hand: 0, reserved: 0 };
  return { ...stock, available: stock.on_hand - stock.reserved };
}

export async function getLedger(pool: pg.Pool, productId: string, warehouseId: string) {
  const { rows } = await pool.query(
    "SELECT * FROM inventory_ledger WHERE product_id = $1 AND warehouse_id = $2 ORDER BY id", [productId, warehouseId]
  );
  return rows;
}
