import type pg from "pg";

export interface JobEscalation {
  id: string;
  job_id: string;
  trigger_reason: "no_supervisor_online" | "never_assigned" | "timeout" | "rejected" | "emergency";
  escalated_at: Date;
  escalated_by: string | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

export class JobAlreadyEscalatedError extends Error {
  constructor() { super("This job already has an open, unresolved escalation"); this.name = "JobAlreadyEscalatedError"; }
}
export class NoOpenEscalationError extends Error {
  constructor() { super("This job has no open escalation to resolve"); this.name = "NoOpenEscalationError"; }
}

// JOB-003: any of 5 named triggers. Deliberately just an explicit,
// named reason recorded here — detecting WHEN each trigger condition
// is true (e.g. actually polling "is a Supervisor online") is a
// separate concern for whichever caller decides to escalate; this
// function's job is only to make the resulting escalation queue entry
// real, queryable, and reason-labeled, never a silent "someone should
// look at this eventually."
export async function escalateJob(pool: pg.Pool, jobId: string, triggerReason: JobEscalation["trigger_reason"], escalatedBy?: string): Promise<JobEscalation> {
  try {
    const { rows } = await pool.query<JobEscalation>(
      "INSERT INTO job_escalations (job_id, trigger_reason, escalated_by) VALUES ($1, $2, $3) RETURNING *",
      [jobId, triggerReason, escalatedBy ?? null]
    );
    return rows[0]!;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new JobAlreadyEscalatedError();
    throw err;
  }
}

export async function resolveEscalation(pool: pg.Pool, jobId: string, resolvedBy: string, resolutionNote?: string): Promise<JobEscalation> {
  const { rows } = await pool.query<JobEscalation>(
    "UPDATE job_escalations SET resolved_at = now(), resolved_by = $1, resolution_note = $2 WHERE job_id = $3 AND resolved_at IS NULL RETURNING *",
    [resolvedBy, resolutionNote ?? null, jobId]
  );
  if (!rows[0]) throw new NoOpenEscalationError();
  return rows[0];
}

export async function listOpenEscalations(pool: pg.Pool, organizationId: string): Promise<JobEscalation[]> {
  const { rows } = await pool.query<JobEscalation>(
    `SELECT je.* FROM job_escalations je JOIN jobs j ON j.id = je.job_id
     WHERE j.organization_id = $1 AND je.resolved_at IS NULL ORDER BY je.escalated_at`,
    [organizationId]
  );
  return rows;
}
