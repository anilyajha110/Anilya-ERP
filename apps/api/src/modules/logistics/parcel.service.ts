import type pg from "pg";
import { transitionOrder, getOrderById } from "../orders/order.service.js";

export interface Parcel {
  id: string;
  organization_id: string;
  status: "open" | "dispatched" | "out_for_delivery" | "delivered";
  courier_reference: string | null;
  created_by: string | null;
  created_at: Date;
  dispatched_at: Date | null;
  delivered_at: Date | null;
}

export class OrderNotReadyForParcelError extends Error {
  constructor(actualStage: string) { super(`Cannot add an order in stage '${actualStage}' to a parcel — it must be 'completed' first`); this.name = "OrderNotReadyForParcelError"; }
}
export class OrderAlreadyInParcelError extends Error {
  constructor() { super("This order already belongs to a parcel — split it out first if it needs to move to a different one"); this.name = "OrderAlreadyInParcelError"; }
}
export class ParcelNotInExpectedStatusError extends Error {
  constructor(action: string, status: string) { super(`Cannot '${action}' a parcel in status '${status}'`); this.name = "ParcelNotInExpectedStatusError"; }
}

export async function createParcel(pool: pg.Pool, params: { organizationId: string; courierReference?: string; createdBy?: string }): Promise<Parcel> {
  const { rows } = await pool.query<Parcel>(
    "INSERT INTO parcels (organization_id, courier_reference, created_by) VALUES ($1, $2, $3) RETURNING *",
    [params.organizationId, params.courierReference ?? null, params.createdBy ?? null]
  );
  return rows[0]!;
}

export async function getParcelById(pool: pg.Pool, id: string): Promise<Parcel | null> {
  const { rows } = await pool.query<Parcel>("SELECT * FROM parcels WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function getParcelMembers(pool: pg.Pool, parcelId: string) {
  const { rows } = await pool.query("SELECT order_id FROM parcel_orders WHERE parcel_id = $1", [parcelId]);
  return rows.map((r) => r.order_id as string);
}

// LOG-001: an order joins a parcel only once it's 'completed' —
// ready to ship — and only if it isn't already in a different parcel
// (the UNIQUE constraint on parcel_orders.order_id enforces the second
// part at the database level; this function checks the first).
export async function addOrderToParcel(pool: pg.Pool, parcelId: string, orderId: string): Promise<void> {
  const order = await getOrderById(pool, orderId);
  if (!order) throw new Error("Order not found");
  if (order.stage !== "completed") throw new OrderNotReadyForParcelError(order.stage);

  try {
    await pool.query("INSERT INTO parcel_orders (parcel_id, order_id) VALUES ($1, $2)", [parcelId, orderId]);
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new OrderAlreadyInParcelError();
    throw err;
  }
}

// LOG-002: splitting an order OUT of a parcel — it proceeds
// independently from this point on, completely unaffected by whatever
// happens to the rest of the parcel afterward. Deliberately allowed at
// any parcel status (a hub might split an order out even mid-journey).
export async function splitOrderFromParcel(pool: pg.Pool, orderId: string): Promise<void> {
  await pool.query("DELETE FROM parcel_orders WHERE order_id = $1", [orderId]);
}

// The ONE place that cascades a parcel-level status change to every
// member order — walks parcel_orders and calls transitionOrder() for
// each one individually, so every normal per-order rule (state-machine
// validation, real-time audit logging) still applies exactly as it
// would for any other transition, never bypassed for parcel members.
async function cascadeToMembers(pool: pg.Pool, parcelId: string, orderAction: string) {
  const memberIds = await getParcelMembers(pool, parcelId);
  for (const orderId of memberIds) {
    await transitionOrder(pool, orderId, orderAction);
  }
}

export async function dispatchParcel(pool: pg.Pool, parcelId: string): Promise<Parcel> {
  const parcel = await getParcelById(pool, parcelId);
  if (!parcel) throw new Error("Parcel not found");
  if (parcel.status !== "open") throw new ParcelNotInExpectedStatusError("dispatch", parcel.status);

  await cascadeToMembers(pool, parcelId, "dispatch");
  const { rows } = await pool.query<Parcel>("UPDATE parcels SET status = 'dispatched', dispatched_at = now() WHERE id = $1 RETURNING *", [parcelId]);
  return rows[0]!;
}

export async function markParcelOutForDelivery(pool: pg.Pool, parcelId: string): Promise<Parcel> {
  const parcel = await getParcelById(pool, parcelId);
  if (!parcel) throw new Error("Parcel not found");
  if (parcel.status !== "dispatched") throw new ParcelNotInExpectedStatusError("mark out for delivery", parcel.status);

  await cascadeToMembers(pool, parcelId, "outForDelivery");
  const { rows } = await pool.query<Parcel>("UPDATE parcels SET status = 'out_for_delivery' WHERE id = $1 RETURNING *", [parcelId]);
  return rows[0]!;
}

export async function markParcelDelivered(pool: pg.Pool, parcelId: string): Promise<Parcel> {
  const parcel = await getParcelById(pool, parcelId);
  if (!parcel) throw new Error("Parcel not found");
  if (parcel.status !== "out_for_delivery") throw new ParcelNotInExpectedStatusError("deliver", parcel.status);

  await cascadeToMembers(pool, parcelId, "deliver");
  const { rows } = await pool.query<Parcel>("UPDATE parcels SET status = 'delivered', delivered_at = now() WHERE id = $1 RETURNING *", [parcelId]);
  return rows[0]!;
}
