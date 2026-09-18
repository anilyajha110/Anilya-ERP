import type pg from "pg";

export interface ArtworkVersion {
  id: number;
  order_id: string;
  stage: "customer_upload" | "customer_approved_artwork" | "print_reviewed" | "print_approved";
  file_reference: string;
  uploaded_by: string | null;
  uploaded_at: Date;
}

export class OrderArtworkNotFoundError extends Error {
  constructor() { super("This order has no artwork record — it may not require artwork at all"); this.name = "OrderArtworkNotFoundError"; }
}
export class PrintReviewRequiredFirstError extends Error {
  constructor() { super("No print_reviewed version exists yet for this order — the internal technical check must happen before final approval"); this.name = "PrintReviewRequiredFirstError"; }
}

async function recordVersion(pool: pg.Pool, orderId: string, stage: ArtworkVersion["stage"], fileReference: string, uploadedBy?: string): Promise<ArtworkVersion> {
  const { rows } = await pool.query<ArtworkVersion>(
    "INSERT INTO artwork_versions (order_id, stage, file_reference, uploaded_by) VALUES ($1, $2, $3, $4) RETURNING *",
    [orderId, stage, fileReference, uploadedBy ?? null]
  );
  return rows[0]!;
}

// Stage 1 — customer uploads (or AMS creates, for 'no'-intent orders)
// a first artwork file. Records a new version; does not change
// ams_stage (import already set the correct starting stage).
export async function submitCustomerUpload(pool: pg.Pool, orderId: string, fileReference: string, uploadedBy?: string): Promise<ArtworkVersion> {
  return recordVersion(pool, orderId, "customer_upload", fileReference, uploadedBy);
}

// Stage 2 — the customer approves. This is deliberately NOT the same
// thing as print-ready (ADR 0002) — customer_approved_ref is stored as
// a locked historical reference only, and ams_stage automatically
// advances to final_artwork_inspector, but print_ready stays false
// here, on purpose, no matter what.
export async function submitCustomerApproval(pool: pg.Pool, orderId: string, fileReference: string, uploadedBy?: string): Promise<ArtworkVersion> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM order_artwork WHERE order_id = $1 FOR UPDATE", [orderId]);
    if (!rows[0]) throw new OrderArtworkNotFoundError();

    const { rows: versionRows } = await client.query<ArtworkVersion>(
      "INSERT INTO artwork_versions (order_id, stage, file_reference, uploaded_by) VALUES ($1, 'customer_approved_artwork', $2, $3) RETURNING *",
      [orderId, fileReference, uploadedBy ?? null]
    );
    await client.query(
      "UPDATE order_artwork SET customer_approved_ref = $1, ams_stage = 'final_artwork_inspector', updated_at = now() WHERE order_id = $2",
      [fileReference, orderId]
    );
    await client.query("COMMIT");
    return versionRows[0]!;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Stage 3 — an Operator's technical check (dimensions/DPI/bleed/
// colour/cutting), BEFORE Supervisor sign-off. Required to exist
// before Stage 4 can happen at all.
export async function submitPrintReview(pool: pg.Pool, orderId: string, fileReference: string, uploadedBy?: string): Promise<ArtworkVersion> {
  return recordVersion(pool, orderId, "print_reviewed", fileReference, uploadedBy);
}

// Stage 4 — Supervisor's FINAL approval. This is the ONLY function
// anywhere in this system that may set print_ready = true — the exact
// gate transitionOrder()'s 'start' action checks (order.service.ts).
export async function submitPrintApproval(pool: pg.Pool, orderId: string, fileReference: string, uploadedBy?: string): Promise<ArtworkVersion> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: reviewed } = await client.query(
      "SELECT 1 FROM artwork_versions WHERE order_id = $1 AND stage = 'print_reviewed' LIMIT 1", [orderId]
    );
    if (!reviewed[0]) throw new PrintReviewRequiredFirstError();

    const { rows: versionRows } = await client.query<ArtworkVersion>(
      "INSERT INTO artwork_versions (order_id, stage, file_reference, uploaded_by) VALUES ($1, 'print_approved', $2, $3) RETURNING *",
      [orderId, fileReference, uploadedBy ?? null]
    );
    await client.query(
      "UPDATE order_artwork SET print_ready = true, print_ready_at = now(), ams_stage = NULL, updated_at = now() WHERE order_id = $1",
      [orderId]
    );
    await client.query("COMMIT");
    return versionRows[0]!;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getArtworkVersions(pool: pg.Pool, orderId: string): Promise<ArtworkVersion[]> {
  const { rows } = await pool.query<ArtworkVersion>("SELECT * FROM artwork_versions WHERE order_id = $1 ORDER BY uploaded_at", [orderId]);
  return rows;
}

export async function getOrderArtworkStatus(pool: pg.Pool, orderId: string) {
  const { rows } = await pool.query("SELECT * FROM order_artwork WHERE order_id = $1", [orderId]);
  return rows[0] ?? null;
}
