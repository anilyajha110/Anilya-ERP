import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { requireAuth, requirePermission } from "../identity/rbac.js";
import { createJob, listJobsForOrder, getJobById, assignJobToPartner, startJob, completeJob, PartnerNeverLoggedInError, JobNotInExpectedStatusError } from "./job.service.js";
import { escalateJob, resolveEscalation, listOpenEscalations, JobAlreadyEscalatedError, NoOpenEscalationError } from "./escalation.service.js";
import { logActivity } from "../identity/audit.service.js";

function getIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}
function requireParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string") throw new Error(`Expected route param '${name}' to be present`);
  return value;
}

export function createJobsRouter(pool: pg.Pool): Router {
  const router = Router();

  router.post("/orders/:orderId/jobs", requireAuth(pool), requirePermission(pool, "jobs.manage"), async (req: Request, res: Response) => {
    const { jobType, description } = req.body ?? {};
    if (!jobType || !description) return res.status(400).json({ error: "jobType and description are required" });
    const job = await createJob(pool, { organizationId: req.identity!.organization_id, orderId: requireParam(req, "orderId"), jobType, description, createdBy: req.identity!.id });
    await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "job.created", entityType: "job", entityId: job.id, ipAddress: getIp(req), sessionId: req.sessionId, remarks: description });
    res.status(201).json(job);
  });

  router.get("/orders/:orderId/jobs", requireAuth(pool), requirePermission(pool, "jobs.manage"), async (req: Request, res: Response) => {
    res.json(await listJobsForOrder(pool, requireParam(req, "orderId")));
  });

  router.get("/jobs/:id", requireAuth(pool), requirePermission(pool, "jobs.manage"), async (req: Request, res: Response) => {
    const job = await getJobById(pool, requireParam(req, "id"));
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(job);
  });

  // JOB-004's gate lives inside assignJobToPartner itself — this route
  // is just the HTTP surface over it.
  router.post("/jobs/:id/assign", requireAuth(pool), requirePermission(pool, "jobs.manage"), async (req: Request, res: Response) => {
    const { partnerIdentityId } = req.body ?? {};
    if (!partnerIdentityId) return res.status(400).json({ error: "partnerIdentityId is required" });
    try {
      const job = await assignJobToPartner(pool, requireParam(req, "id"), partnerIdentityId);
      await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "job.assigned", entityType: "job", entityId: job.id, ipAddress: getIp(req), sessionId: req.sessionId, remarks: `assigned to ${partnerIdentityId}` });
      res.json(job);
    } catch (err) {
      if (err instanceof PartnerNeverLoggedInError || err instanceof JobNotInExpectedStatusError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  router.post("/jobs/:id/start", requireAuth(pool), requirePermission(pool, "jobs.manage"), async (req: Request, res: Response) => {
    try {
      const job = await startJob(pool, requireParam(req, "id"));
      await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "job.started", entityType: "job", entityId: job.id, ipAddress: getIp(req), sessionId: req.sessionId });
      res.json(job);
    } catch (err) {
      if (err instanceof JobNotInExpectedStatusError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  router.post("/jobs/:id/complete", requireAuth(pool), requirePermission(pool, "jobs.manage"), async (req: Request, res: Response) => {
    try {
      const job = await completeJob(pool, requireParam(req, "id"));
      await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "job.completed", entityType: "job", entityId: job.id, ipAddress: getIp(req), sessionId: req.sessionId });
      res.json(job);
    } catch (err) {
      if (err instanceof JobNotInExpectedStatusError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  // --- Escalation (JOB-003) ---

  router.get("/escalations", requireAuth(pool), requirePermission(pool, "jobs.escalations.manage"), async (req: Request, res: Response) => {
    res.json(await listOpenEscalations(pool, req.identity!.organization_id));
  });

  router.post("/jobs/:id/escalate", requireAuth(pool), requirePermission(pool, "jobs.manage"), async (req: Request, res: Response) => {
    const { triggerReason } = req.body ?? {};
    const validReasons = ["no_supervisor_online", "never_assigned", "timeout", "rejected", "emergency"];
    if (!validReasons.includes(triggerReason)) return res.status(400).json({ error: `triggerReason must be one of: ${validReasons.join(", ")}` });
    try {
      const escalation = await escalateJob(pool, requireParam(req, "id"), triggerReason, req.identity!.id);
      await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "job.escalated", entityType: "job", entityId: requireParam(req, "id"), ipAddress: getIp(req), sessionId: req.sessionId, remarks: triggerReason });
      res.status(201).json(escalation);
    } catch (err) {
      if (err instanceof JobAlreadyEscalatedError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  // Resolving an escalation is a Manager-level action — its own,
  // narrower permission than ordinary jobs.manage.
  router.post("/jobs/:id/escalate/resolve", requireAuth(pool), requirePermission(pool, "jobs.escalations.manage"), async (req: Request, res: Response) => {
    const { resolutionNote } = req.body ?? {};
    try {
      const escalation = await resolveEscalation(pool, requireParam(req, "id"), req.identity!.id, resolutionNote);
      await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "job.escalation_resolved", entityType: "job", entityId: requireParam(req, "id"), ipAddress: getIp(req), sessionId: req.sessionId, remarks: resolutionNote });
      res.json(escalation);
    } catch (err) {
      if (err instanceof NoOpenEscalationError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  return router;
}
