import type pg from "pg";

export interface GangRun {
  id: string;
  organization_id: string;
  status: "open" | "completed" | "cancelled";
  created_by: string | null;
  created_at: Date;
  completed_at: Date | null;
  cancelled_at: Date | null;
}

export class OrderNotPrintReadyError extends Error {
  constructor() { super("An order may only join a Gang Run once it is individually print-ready — Gang Run combination is not a substitute for that approval (ADR 0002 / ART-004)"); this.name = "OrderNotPrintReadyError"; }
}
export class OrderAlreadyInGangRunError extends Error {
  constructor() { super("This order already belongs to a Gang Run"); this.name = "OrderAlreadyInGangRunError"; }
}
export class GangRunNotOpenError extends Error {
  constructor(status: string) { super(`This Gang Run is '${status}' — members can only be added while it is 'open'`); this.name = "GangRunNotOpenError"; }
}

export async function createGangRun(pool: pg.Pool, organizationId: string, createdBy?: string): Promise<GangRun> {
  const { rows } = await pool.query<GangRun>(
    "INSERT INTO gang_runs (organization_id, created_by) VALUES ($1, $2) RETURNING *",
    [organizationId, createdBy ?? null]
  );
  return rows[0]!;
}

export async function getGangRun(pool: pg.Pool, id: string): Promise<GangRun | null> {
  const { rows } = await pool.query<GangRun>("SELECT * FROM gang_runs WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function getGangRunMembers(pool: pg.Pool, gangRunId: string) {
  const { rows } = await pool.query(
    `SELECT o.id, o.display_order_number, o.product_name, o.stage, m.added_at
     FROM gang_run_members m JOIN orders o ON o.id = m.order_id
     WHERE m.gang_run_id = $1 ORDER BY m.added_at`,
    [gangRunId]
  );
  return rows;
}

// The ONE function that checks ART-004 before letting an order into a
// Gang Run — every write path funnels through here, so the rule can't
// be bypassed by a different route calling a different function.
export async function addOrderToGangRun(pool: pg.Pool, gangRunId: string, orderId: string, addedBy?: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: gangRows } = await client.query<GangRun>("SELECT * FROM gang_runs WHERE id = $1 FOR UPDATE", [gangRunId]);
    if (!gangRows[0]) throw new Error("Gang Run not found");
    if (gangRows[0].status !== "open") throw new GangRunNotOpenError(gangRows[0].status);

    const { rows: artworkRows } = await client.query<{ print_ready: boolean }>(
      "SELECT print_ready FROM order_artwork WHERE order_id = $1", [orderId]
    );
    // No order_artwork row at all can only mean the order doesn't
    // require artwork (Phase 5's 'blank' intent never creates a row it
    // doesn't need) — such an order has nothing to gang-print in the
    // first place, so treat "no row" the same as "not print-ready" here:
    // Gang Run exists specifically to combine artwork-bearing print jobs.
    if (!artworkRows[0]?.print_ready) throw new OrderNotPrintReadyError();

    try {
      await client.query("INSERT INTO gang_run_members (gang_run_id, order_id, added_by) VALUES ($1, $2, $3)", [gangRunId, orderId, addedBy ?? null]);
    } catch (err) {
      if ((err as { code?: string }).code === "23505") throw new OrderAlreadyInGangRunError();
      throw err;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ART-005: the Shadow ID "closes" — status changes — but member rows
// are never deleted. The full history of which orders were pooled
// together remains queryable forever via getGangRunMembers.
export async function completeGangRun(pool: pg.Pool, id: string): Promise<GangRun> {
  const { rows } = await pool.query<GangRun>(
    "UPDATE gang_runs SET status = 'completed', completed_at = now() WHERE id = $1 AND status = 'open' RETURNING *",
    [id]
  );
  if (!rows[0]) throw new GangRunNotOpenError((await getGangRun(pool, id))?.status ?? "not found");
  return rows[0];
}
