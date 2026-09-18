import type pg from "pg";

export interface OperatorLedgerEntry {
  id: string;
  organization_id: string;
  operator_identity_id: string;
  particular: "payable" | "payment" | "adjustment";
  external_reference: string | null;
  amount: string;
  previous_balance: string;
  final_balance: string;
  remarks: string | null;
  created_at: Date;
}

// The ONE function that ever writes a row here — every entry computes
// its own running balance from the immediately previous one, inside a
// row-locked transaction, so two concurrent postings can never both
// read the same stale "previous balance" (the same real concurrency
// hazard customer_ledger, Phase 3, guards against the same way).
async function postEntry(
  pool: pg.Pool,
  params: { organizationId: string; operatorIdentityId: string; particular: OperatorLedgerEntry["particular"]; amount: number; externalReference?: string; remarks?: string; createdBy?: string }
): Promise<OperatorLedgerEntry> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: lastRows } = await client.query<{ final_balance: string }>(
      "SELECT final_balance FROM operator_ledger WHERE operator_identity_id = $1 ORDER BY id DESC LIMIT 1 FOR UPDATE",
      [params.operatorIdentityId]
    );
    const previousBalance = lastRows[0] ? Number(lastRows[0].final_balance) : 0;
    // 'payable' (money owed TO the operator) increases the balance;
    // 'payment' (money actually paid out) decreases it — the ERP does
    // no rate math here at all, it only ever adds or subtracts exactly
    // the figure the caller (ultimately, AMS) reported (JOB-007).
    const delta = params.particular === "payment" ? -params.amount : params.amount;
    const finalBalance = previousBalance + delta;

    const { rows } = await client.query<OperatorLedgerEntry>(
      `INSERT INTO operator_ledger (organization_id, operator_identity_id, particular, external_reference, amount, previous_balance, final_balance, remarks, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [params.organizationId, params.operatorIdentityId, params.particular, params.externalReference ?? null, params.amount, previousBalance, finalBalance, params.remarks ?? null, params.createdBy ?? null]
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

export async function recordPayable(pool: pg.Pool, params: { organizationId: string; operatorIdentityId: string; amount: number; externalReference: string; remarks?: string; createdBy?: string }): Promise<{ entry: OperatorLedgerEntry; wasNew: boolean }> {
  // JOB-007: AMS may resend the same completed-work notification (a
  // retry, a duplicate webhook) — externalReference is a genuine
  // idempotency key here, exactly like Orders' idempotencyKey (Phase
  // 4). Replaying the same WORK_ID must be a safe no-op, never a
  // second payable entry that double-credits the operator.
  const { rows: existing } = await pool.query<OperatorLedgerEntry>(
    "SELECT * FROM operator_ledger WHERE operator_identity_id = $1 AND external_reference = $2 AND particular = 'payable'",
    [params.operatorIdentityId, params.externalReference]
  );
  if (existing[0]) return { entry: existing[0], wasNew: false };

  const entry = await postEntry(pool, { ...params, particular: "payable" });
  return { entry, wasNew: true };
}

export async function recordPayment(pool: pg.Pool, params: { organizationId: string; operatorIdentityId: string; amount: number; remarks?: string; createdBy?: string }): Promise<OperatorLedgerEntry> {
  return postEntry(pool, { ...params, particular: "payment" });
}

export async function getLedger(pool: pg.Pool, operatorIdentityId: string): Promise<OperatorLedgerEntry[]> {
  const { rows } = await pool.query<OperatorLedgerEntry>("SELECT * FROM operator_ledger WHERE operator_identity_id = $1 ORDER BY id", [operatorIdentityId]);
  return rows;
}

export async function getCurrentBalance(pool: pg.Pool, operatorIdentityId: string): Promise<number> {
  const { rows } = await pool.query<{ final_balance: string }>("SELECT final_balance FROM operator_ledger WHERE operator_identity_id = $1 ORDER BY id DESC LIMIT 1", [operatorIdentityId]);
  return rows[0] ? Number(rows[0].final_balance) : 0;
}
