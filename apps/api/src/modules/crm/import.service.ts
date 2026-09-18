import type pg from "pg";
import { findOrCreateCustomer } from "./customer.service.js";

export interface ImportRow {
  name: string;
  phone?: string;
  email?: string;
}

export interface PreviewResult {
  rowNumber: number;
  input: ImportRow;
  matchType: "existing" | "new";
  matchedIdentityId?: string;
}

// CRM-004: preview WITHOUT writing anything — lets an operator see
// exactly which rows will match an existing customer and which will
// create a new one, before committing to either. Read-only: uses the
// same lookup logic as findOrCreateCustomer would, but never calls the
// creating branch.
export async function previewImport(pool: pg.Pool, organizationId: string, rows: ImportRow[]): Promise<PreviewResult[]> {
  const results: PreviewResult[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    let matched: { identity_id: string } | null = null;
    if (row.phone) {
      const { rows: r } = await pool.query("SELECT id AS identity_id FROM identities WHERE organization_id = $1 AND identity_type = 'customer' AND phone = $2", [organizationId, row.phone]);
      matched = r[0] ?? null;
    }
    if (!matched && row.email) {
      const { rows: r } = await pool.query("SELECT id AS identity_id FROM identities WHERE organization_id = $1 AND identity_type = 'customer' AND email = $2", [organizationId, row.email]);
      matched = r[0] ?? null;
    }
    results.push({
      rowNumber: i + 1, input: row,
      matchType: matched ? "existing" : "new",
      matchedIdentityId: matched?.identity_id,
    });
  }
  return results;
}

// Actually performs the find-or-create for every row, records exactly
// what happened per row in import_batch_entries — this record is what
// makes rollback safe later (it knows precisely which customers this
// batch itself created vs. merely matched).
export async function commitImport(
  pool: pg.Pool, organizationId: string, rows: ImportRow[], createdBy?: string
): Promise<{ batchId: string; created: number; matched: number }> {
  const { rows: batchRows } = await pool.query<{ id: string }>(
    "INSERT INTO import_batches (organization_id, created_by, status) VALUES ($1, $2, 'committed') RETURNING id",
    [organizationId, createdBy ?? null]
  );
  const batchId = batchRows[0]!.id;
  let created = 0, matched = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const { customer, wasNew } = await findOrCreateCustomer(pool, { organizationId, displayName: row.name, phone: row.phone, email: row.email });
    if (wasNew) created++; else matched++;

    await pool.query(
      `INSERT INTO import_batch_entries (batch_id, row_number, input_name, input_phone, input_email, matched_identity_id, created_identity_id, was_new_customer)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [batchId, i + 1, row.name, row.phone ?? null, row.email ?? null, wasNew ? null : customer.identity_id, wasNew ? customer.identity_id : null, wasNew]
    );
  }
  await pool.query("UPDATE import_batches SET committed_at = now() WHERE id = $1", [batchId]);
  return { batchId, created, matched };
}

export class BatchAlreadyRolledBackError extends Error {
  constructor() { super("This import batch has already been rolled back"); this.name = "BatchAlreadyRolledBackError"; }
}
export class BatchNotCommittedError extends Error {
  constructor() { super("Only a committed batch can be rolled back"); this.name = "BatchNotCommittedError"; }
}

// Deletes ONLY the customers this specific batch created — a customer
// this batch merely matched (already existed beforehand) is never
// touched, regardless of how the rollback is invoked. This is the
// safety property that makes rollback trustworthy at all.
export async function rollbackImport(pool: pg.Pool, batchId: string): Promise<{ deletedCustomers: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: batchRows } = await client.query("SELECT * FROM import_batches WHERE id = $1 FOR UPDATE", [batchId]);
    if (!batchRows[0]) throw new Error("Batch not found");
    if (batchRows[0].status === "rolled_back") throw new BatchAlreadyRolledBackError();
    if (batchRows[0].status !== "committed") throw new BatchNotCommittedError();

    const { rows: entries } = await client.query(
      "SELECT created_identity_id FROM import_batch_entries WHERE batch_id = $1 AND was_new_customer = true",
      [batchId]
    );
    for (const entry of entries) {
      // A customer created by this batch might already have ledger
      // entries or other activity by the time someone rolls back — if
      // so, this delete will fail on the foreign key rather than
      // silently orphaning data, which is the correct, safe failure mode.
      await client.query("DELETE FROM customer_profiles WHERE identity_id = $1", [entry.created_identity_id]);
      await client.query("DELETE FROM identities WHERE id = $1", [entry.created_identity_id]);
    }
    await client.query("UPDATE import_batches SET status = 'rolled_back', rolled_back_at = now() WHERE id = $1", [batchId]);
    await client.query("COMMIT");
    return { deletedCustomers: entries.length };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
