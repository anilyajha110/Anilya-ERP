import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { requireAuth, requirePermission } from "../identity/rbac.js";
import { createGangRun, getGangRun, getGangRunMembers, addOrderToGangRun, completeGangRun, OrderNotPrintReadyError, OrderAlreadyInGangRunError, GangRunNotOpenError } from "./gang-run.service.js";
import { logActivity } from "../identity/audit.service.js";

function getIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}
function requireParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string") throw new Error(`Expected route param '${name}' to be present`);
  return value;
}

export function createGangRunRouter(pool: pg.Pool): Router {
  const router = Router();

  router.post("/gang-runs", requireAuth(pool), requirePermission(pool, "gangrun.manage"), async (req: Request, res: Response) => {
    const gangRun = await createGangRun(pool, req.identity!.organization_id, req.identity!.id);
    await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "gangrun.created", entityType: "gang_run", entityId: gangRun.id, ipAddress: getIp(req), sessionId: req.sessionId });
    res.status(201).json(gangRun);
  });

  router.get("/gang-runs/:id", requireAuth(pool), requirePermission(pool, "gangrun.manage"), async (req: Request, res: Response) => {
    const gangRun = await getGangRun(pool, requireParam(req, "id"));
    if (!gangRun) return res.status(404).json({ error: "Gang Run not found" });
    res.json(gangRun);
  });

  router.get("/gang-runs/:id/members", requireAuth(pool), requirePermission(pool, "gangrun.manage"), async (req: Request, res: Response) => {
    res.json(await getGangRunMembers(pool, requireParam(req, "id")));
  });

  // The single most important endpoint in this module — every request
  // here either succeeds because the order is genuinely print-ready, or
  // fails with a specific, named reason (409). Never a silent success.
  router.post("/gang-runs/:id/members", requireAuth(pool), requirePermission(pool, "gangrun.manage"), async (req: Request, res: Response) => {
    const { orderId } = req.body ?? {};
    if (!orderId) return res.status(400).json({ error: "orderId is required" });
    try {
      await addOrderToGangRun(pool, requireParam(req, "id"), orderId, req.identity!.id);
      await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "gangrun.member_added", entityType: "gang_run", entityId: requireParam(req, "id"), ipAddress: getIp(req), sessionId: req.sessionId, remarks: `order ${orderId} added` });
      res.status(201).json({ added: true });
    } catch (err) {
      if (err instanceof OrderNotPrintReadyError || err instanceof OrderAlreadyInGangRunError || err instanceof GangRunNotOpenError) {
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }
  });

  router.post("/gang-runs/:id/complete", requireAuth(pool), requirePermission(pool, "gangrun.manage"), async (req: Request, res: Response) => {
    try {
      const gangRun = await completeGangRun(pool, requireParam(req, "id"));
      await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "gangrun.completed", entityType: "gang_run", entityId: gangRun.id, ipAddress: getIp(req), sessionId: req.sessionId });
      res.json(gangRun);
    } catch (err) {
      if (err instanceof GangRunNotOpenError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  return router;
}
