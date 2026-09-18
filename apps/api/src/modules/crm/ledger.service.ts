import type pg from "pg";

export interface LedgerEntry {
  id: number;
  particular: "job" | "payment" | "adjustment";
  previous_balance: string;
  job_value: string;
  payment_amount: string;
  adjustment: string;
  final_balance: string;
  remarks: string | null;
  created_at: Date;
}

// The ONLY function anywhere that writes to customer_ledger — mirrors
// the same "one writer function" discipline the prototype's ledgers
// used, now backed by a database CHECK constraint (migration 0009)
// that would reject this function itself if the math were ever wrong.
export async function addLedgerEntry(
  pool: pg.Pool,
  params: {
    organizationId: string; customerIdentityId: string; particular: LedgerEntry["particular"];
    jobValue?: number; paymentAmount?: number; adjustment?: number; remarks?: string; createdBy?: string;
  }
): Promise<LedgerEntry> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Lock the customer's row for the duration of this transaction so
    // two concurrent postings can't both read the same "previous
    // balance" and produce two entries that are each individually
    // correct but collectively wrong (a real concurrency hazard a
    // naive read-then-insert would have).
    const { rows: lastRows } = await client.query<{ final_balance: string }>(
      `SELECT final_balance FROM customer_ledger WHERE customer_identity_id = $1 ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [params.customerIdentityId]
    );
    const previousBalance = lastRows[0] ? Number(lastRows[0].final_balance) : 0;
    const jobValue = params.jobValue ?? 0;
    const paymentAmount = params.paymentAmount ?? 0;
    const adjustment = params.adjustment ?? 0;
    const finalBalance = previousBalance + jobValue - paymentAmount + adjustment;

    const { rows } = await client.query<LedgerEntry>(
      `INSERT INTO customer_ledger (organization_id, customer_identity_id, particular, previous_balance, job_value, payment_amount, adjustment, final_balance, remarks, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [params.organizationId, params.customerIdentityId, params.particular, previousBalance, jobValue, paymentAmount, adjustment, finalBalance, params.remarks ?? null, params.createdBy ?? null]
    );
    await client.query("COMMIT");
    return rows[0]!;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getLedger(pool: pg.Pool, customerIdentityId: string): Promise<LedgerEntry[]> {
  const { rows } = await pool.query<LedgerEntry>(
    "SELECT * FROM customer_ledger WHERE customer_identity_id = $1 ORDER BY id",
    [customerIdentityId]
  );
  return rows;
}

export async function getCurrentBalance(pool: pg.Pool, customerIdentityId: string): Promise<number> {
  const { rows } = await pool.query<{ final_balance: string }>(
    "SELECT final_balance FROM customer_ledger WHERE customer_identity_id = $1 ORDER BY id DESC LIMIT 1",
    [customerIdentityId]
  );
  return rows[0] ? Number(rows[0].final_balance) : 0;
}
