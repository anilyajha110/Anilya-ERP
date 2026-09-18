import type pg from "pg";

export interface Job {
  id: string;
  organization_id: string;
  order_id: string;
  job_type: "fixed" | "extra";
  description: string;
  status: "open" | "assigned" | "in_progress" | "completed" | "cancelled";
  assigned_partner_identity_id: string | null;
  created_at: Date;
  assigned_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
}

export class PartnerNeverLoggedInError extends Error {
  constructor() { super("This Partner has never logged in and cannot receive a direct job assignment — route through escalation instead (JOB-004)"); this.name = "PartnerNeverLoggedInError"; }
}
export class JobNotInExpectedStatusError extends Error {
  constructor(action: string, status: string) { super(`Cannot '${action}' a job in status '${status}'`); this.name = "JobNotInExpectedStatusError"; }
}

export async function createJob(pool: pg.Pool, params: { organizationId: string; orderId: string; jobType: "fixed" | "extra"; description: string; createdBy?: string }): Promise<Job> {
  const { rows } = await pool.query<Job>(
    "INSERT INTO jobs (organization_id, order_id, job_type, description, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    [params.organizationId, params.orderId, params.jobType, params.description, params.createdBy ?? null]
  );
  return rows[0]!;
}

export async function listJobsForOrder(pool: pg.Pool, orderId: string): Promise<Job[]> {
  const { rows } = await pool.query<Job>("SELECT * FROM jobs WHERE order_id = $1 ORDER BY created_at", [orderId]);
  return rows;
}

export async function getJobById(pool: pg.Pool, id: string): Promise<Job | null> {
  const { rows } = await pool.query<Job>("SELECT * FROM jobs WHERE id = $1", [id]);
  return rows[0] ?? null;
}

// JOB-004: the ONE function that assigns a job to a Partner — checked
// against `sessions`, not a stored "has_logged_in" flag on the
// identity, so it always reflects the real, current login history
// rather than a value that could drift out of sync.
export async function assignJobToPartner(pool: pg.Pool, jobId: string, partnerIdentityId: string): Promise<Job> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: jobRows } = await client.query<Job>("SELECT * FROM jobs WHERE id = $1 FOR UPDATE", [jobId]);
    if (!jobRows[0]) throw new Error("Job not found");
    if (jobRows[0].status !== "open") throw new JobNotInExpectedStatusError("assign", jobRows[0].status);

    const { rows: loginRows } = await client.query("SELECT 1 FROM sessions WHERE identity_id = $1 LIMIT 1", [partnerIdentityId]);
    if (!loginRows[0]) throw new PartnerNeverLoggedInError();

    const { rows } = await client.query<Job>(
      "UPDATE jobs SET status = 'assigned', assigned_partner_identity_id = $1, assigned_at = now() WHERE id = $2 RETURNING *",
      [partnerIdentityId, jobId]
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

export async function startJob(pool: pg.Pool, jobId: string): Promise<Job> {
  const { rows } = await pool.query<Job>(
    "UPDATE jobs SET status = 'in_progress', started_at = now() WHERE id = $1 AND status = 'assigned' RETURNING *",
    [jobId]
  );
  if (!rows[0]) {
    const existing = await getJobById(pool, jobId);
    throw new JobNotInExpectedStatusError("start", existing?.status ?? "not found");
  }
  return rows[0];
}

export async function completeJob(pool: pg.Pool, jobId: string): Promise<Job> {
  const { rows } = await pool.query<Job>(
    "UPDATE jobs SET status = 'completed', completed_at = now() WHERE id = $1 AND status = 'in_progress' RETURNING *",
    [jobId]
  );
  if (!rows[0]) {
    const existing = await getJobById(pool, jobId);
    throw new JobNotInExpectedStatusError("complete", existing?.status ?? "not found");
  }
  return rows[0];
}

// JOB-002: every job on the order must be 'completed' (or 'cancelled'
// — a cancelled job isn't blocking anything) before the order itself
// may complete. Returns the list of still-pending jobs so the caller
// can report exactly what's blocking, not just "no."
export async function getIncompleteJobs(pool: pg.Pool, orderId: string): Promise<Job[]> {
  const { rows } = await pool.query<Job>(
    "SELECT * FROM jobs WHERE order_id = $1 AND status NOT IN ('completed', 'cancelled')", [orderId]
  );
  return rows;
}
