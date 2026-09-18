import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { requireAuth, requirePermission } from "../identity/rbac.js";
import { submitCustomerUpload, submitCustomerApproval, submitPrintReview, submitPrintApproval, getArtworkVersions, getOrderArtworkStatus, OrderArtworkNotFoundError, PrintReviewRequiredFirstError } from "./artwork.service.js";
import { logActivity } from "../identity/audit.service.js";

function getIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}
function requireParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string") throw new Error(`Expected route param '${name}' to be present`);
  return value;
}

export function createArtworkRouter(pool: pg.Pool): Router {
  const router = Router();

  router.get("/orders/:id/artwork/status", requireAuth(pool), requirePermission(pool, "orders.read"), async (req: Request, res: Response) => {
    const status = await getOrderArtworkStatus(pool, requireParam(req, "id"));
    if (!status) return res.status(404).json({ error: "No artwork record for this order" });
    res.json(status);
  });

  router.get("/orders/:id/artwork/versions", requireAuth(pool), requirePermission(pool, "orders.read"), async (req: Request, res: Response) => {
    res.json(await getArtworkVersions(pool, requireParam(req, "id")));
  });

  router.post("/orders/:id/artwork/customer-upload", requireAuth(pool), requirePermission(pool, "orders.write"), async (req: Request, res: Response) => {
    const { fileReference } = req.body ?? {};
    if (!fileReference) return res.status(400).json({ error: "fileReference is required" });
    const version = await submitCustomerUpload(pool, requireParam(req, "id"), fileReference, req.identity!.id);
    await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "artwork.customer_upload", entityType: "order", entityId: requireParam(req, "id"), ipAddress: getIp(req), sessionId: req.sessionId, remarks: fileReference });
    res.status(201).json(version);
  });

  router.post("/orders/:id/artwork/customer-approved", requireAuth(pool), requirePermission(pool, "orders.write"), async (req: Request, res: Response) => {
    const { fileReference } = req.body ?? {};
    if (!fileReference) return res.status(400).json({ error: "fileReference is required" });
    try {
      const version = await submitCustomerApproval(pool, requireParam(req, "id"), fileReference, req.identity!.id);
      await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "artwork.customer_approved", entityType: "order", entityId: requireParam(req, "id"), ipAddress: getIp(req), sessionId: req.sessionId, remarks: `${fileReference} — customer approval recorded; NOT print-ready` });
      res.status(201).json(version);
    } catch (err) {
      if (err instanceof OrderArtworkNotFoundError) return res.status(404).json({ error: err.message });
      throw err;
    }
  });

  router.post("/orders/:id/artwork/print-reviewed", requireAuth(pool), requirePermission(pool, "orders.write"), async (req: Request, res: Response) => {
    const { fileReference } = req.body ?? {};
    if (!fileReference) return res.status(400).json({ error: "fileReference is required" });
    const version = await submitPrintReview(pool, requireParam(req, "id"), fileReference, req.identity!.id);
    await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "artwork.print_reviewed", entityType: "order", entityId: requireParam(req, "id"), ipAddress: getIp(req), sessionId: req.sessionId, remarks: fileReference });
    res.status(201).json(version);
  });

  // The only endpoint anywhere that can make an order print-ready —
  // gated separately (orders.artwork.approve) from ordinary orders.write,
  // since this is the single most consequential action in the artwork
  // workflow (ADR 0002).
  router.post("/orders/:id/artwork/print-approved", requireAuth(pool), requirePermission(pool, "orders.artwork.approve"), async (req: Request, res: Response) => {
    const { fileReference } = req.body ?? {};
    if (!fileReference) return res.status(400).json({ error: "fileReference is required" });
    try {
      const version = await submitPrintApproval(pool, requireParam(req, "id"), fileReference, req.identity!.id);
      await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "artwork.print_approved", entityType: "order", entityId: requireParam(req, "id"), ipAddress: getIp(req), sessionId: req.sessionId, remarks: `${fileReference} — PRINT READY` });
      res.status(201).json(version);
    } catch (err) {
      if (err instanceof PrintReviewRequiredFirstError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  return router;
}
