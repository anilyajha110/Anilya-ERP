import type pg from "pg";

export interface VendorRateQuote {
  id: string;
  organization_id: string;
  job_id: string;
  partner_identity_id: string;
  quoted_rate: string;
  reference_rate_at_quote: string;
  status: "auto_accepted" | "pending_approval" | "approved" | "rejected";
  approved_by: string | null;
  approved_at: Date | null;
  created_at: Date;
}

export class QuoteNotPendingError extends Error {
  constructor(status: string) { super(`Cannot approve/reject a quote in status '${status}' — only 'pending_approval' quotes can be decided`); this.name = "QuoteNotPendingError"; }
}

// JOB-006: the ONLY function anywhere that may change
// vendor_master_rates.reference_rate. Deliberately never called from
// submitQuote() or approveQuote() — an explicit, separate, named
// action every time, so a one-off approval can never silently become
// tomorrow's baseline.
export async function setMasterRate(pool: pg.Pool, organizationId: string, category: string, referenceRate: number, updatedBy?: string) {
  const { rows } = await pool.query(
    `INSERT INTO vendor_master_rates (organization_id, category, reference_rate, updated_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, category) DO UPDATE SET reference_rate = $3, updated_by = $4, updated_at = now()
     RETURNING *`,
    [organizationId, category, referenceRate, updatedBy ?? null]
  );
  return rows[0];
}

export async function getMasterRate(pool: pg.Pool, organizationId: string, category: string) {
  const { rows } = await pool.query("SELECT * FROM vendor_master_rates WHERE organization_id = $1 AND category = $2", [organizationId, category]);
  return rows[0] ?? null;
}

// JOB-005: a quote at or under the CURRENT reference rate is accepted
// immediately, with no Manager involved at all. Above it, the quote is
// simply recorded as pending — nothing else happens automatically.
// The reference rate used for this decision is snapshotted onto the
// quote itself (reference_rate_at_quote), so a later master-rate
// change never retroactively changes what this quote's own outcome
// means.
export async function submitQuote(
  pool: pg.Pool,
  params: { organizationId: string; jobId: string; partnerIdentityId: string; quotedRate: number; category: string }
): Promise<VendorRateQuote> {
  const masterRate = await getMasterRate(pool, params.organizationId, params.category);
  const referenceRate = masterRate ? Number(masterRate.reference_rate) : Infinity; // no master rate on file yet — nothing to compare against, so nothing auto-rejects; treated as always requiring approval instead, see below
  const status = masterRate && params.quotedRate <= referenceRate ? "auto_accepted" : "pending_approval";

  const { rows } = await pool.query<VendorRateQuote>(
    `INSERT INTO vendor_rate_quotes (organization_id, job_id, partner_identity_id, quoted_rate, reference_rate_at_quote, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [params.organizationId, params.jobId, params.partnerIdentityId, params.quotedRate, masterRate ? referenceRate : null, status]
  );
  return rows[0]!;
}

export async function approveQuote(pool: pg.Pool, quoteId: string, approvedBy: string): Promise<VendorRateQuote> {
  const { rows } = await pool.query<VendorRateQuote>(
    "UPDATE vendor_rate_quotes SET status = 'approved', approved_by = $1, approved_at = now() WHERE id = $2 AND status = 'pending_approval' RETURNING *",
    [approvedBy, quoteId]
  );
  if (!rows[0]) {
    const { rows: existing } = await pool.query<VendorRateQuote>("SELECT * FROM vendor_rate_quotes WHERE id = $1", [quoteId]);
    throw new QuoteNotPendingError(existing[0]?.status ?? "not found");
  }
  return rows[0];
}

export async function rejectQuote(pool: pg.Pool, quoteId: string, rejectedBy: string): Promise<VendorRateQuote> {
  const { rows } = await pool.query<VendorRateQuote>(
    "UPDATE vendor_rate_quotes SET status = 'rejected', approved_by = $1, approved_at = now() WHERE id = $2 AND status = 'pending_approval' RETURNING *",
    [rejectedBy, quoteId]
  );
  if (!rows[0]) {
    const { rows: existing } = await pool.query<VendorRateQuote>("SELECT * FROM vendor_rate_quotes WHERE id = $1", [quoteId]);
    throw new QuoteNotPendingError(existing[0]?.status ?? "not found");
  }
  return rows[0];
}

export async function listPendingQuotes(pool: pg.Pool, organizationId: string): Promise<VendorRateQuote[]> {
  const { rows } = await pool.query<VendorRateQuote>(
    "SELECT * FROM vendor_rate_quotes WHERE organization_id = $1 AND status = 'pending_approval' ORDER BY created_at", [organizationId]
  );
  return rows;
}
