import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { requireAuth, requirePermission } from "../identity/rbac.js";
import { createParcel, getParcelById, getParcelMembers, addOrderToParcel, splitOrderFromParcel, dispatchParcel, markParcelOutForDelivery, markParcelDelivered, OrderNotReadyForParcelError, OrderAlreadyInParcelError, ParcelNotInExpectedStatusError } from "./parcel.service.js";
import { logActivity } from "../identity/audit.service.js";

function getIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}
function requireParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string") throw new Error(`Expected route param '${name}' to be present`);
  return value;
}

export function createLogisticsRouter(pool: pg.Pool): Router {
  const router = Router();

  router.post("/parcels", requireAuth(pool), requirePermission(pool, "logistics.manage"), async (req: Request, res: Response) => {
    const { courierReference } = req.body ?? {};
    const parcel = await createParcel(pool, { organizationId: req.identity!.organization_id, courierReference, createdBy: req.identity!.id });
    await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "parcel.created", entityType: "parcel", entityId: parcel.id, ipAddress: getIp(req), sessionId: req.sessionId });
    res.status(201).json(parcel);
  });

  router.get("/parcels/:id", requireAuth(pool), requirePermission(pool, "logistics.manage"), async (req: Request, res: Response) => {
    const parcel = await getParcelById(pool, requireParam(req, "id"));
    if (!parcel) return res.status(404).json({ error: "Parcel not found" });
    const memberOrderIds = await getParcelMembers(pool, parcel.id);
    res.json({ ...parcel, memberOrderIds });
  });

  router.post("/parcels/:id/orders", requireAuth(pool), requirePermission(pool, "logistics.manage"), async (req: Request, res: Response) => {
    const { orderId } = req.body ?? {};
    if (!orderId) return res.status(400).json({ error: "orderId is required" });
    try {
      await addOrderToParcel(pool, requireParam(req, "id"), orderId);
      await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "parcel.order_added", entityType: "parcel", entityId: requireParam(req, "id"), ipAddress: getIp(req), sessionId: req.sessionId, remarks: `order ${orderId}` });
      res.status(201).json({ added: true });
    } catch (err) {
      if (err instanceof OrderNotReadyForParcelError || err instanceof OrderAlreadyInParcelError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  // LOG-002: split — the order proceeds independently from this point on.
  router.delete("/parcels/orders/:orderId", requireAuth(pool), requirePermission(pool, "logistics.manage"), async (req: Request, res: Response) => {
    await splitOrderFromParcel(pool, requireParam(req, "orderId"));
    await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "parcel.order_split", entityType: "order", entityId: requireParam(req, "orderId"), ipAddress: getIp(req), sessionId: req.sessionId });
    res.json({ split: true });
  });

  router.post("/parcels/:id/dispatch", requireAuth(pool), requirePermission(pool, "logistics.manage"), async (req: Request, res: Response) => {
    try {
      const parcel = await dispatchParcel(pool, requireParam(req, "id"));
      await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "parcel.dispatched", entityType: "parcel", entityId: parcel.id, ipAddress: getIp(req), sessionId: req.sessionId });
      res.json(parcel);
    } catch (err) {
      if (err instanceof ParcelNotInExpectedStatusError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  router.post("/parcels/:id/out-for-delivery", requireAuth(pool), requirePermission(pool, "logistics.manage"), async (req: Request, res: Response) => {
    try {
      const parcel = await markParcelOutForDelivery(pool, requireParam(req, "id"));
      await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "parcel.out_for_delivery", entityType: "parcel", entityId: parcel.id, ipAddress: getIp(req), sessionId: req.sessionId });
      res.json(parcel);
    } catch (err) {
      if (err instanceof ParcelNotInExpectedStatusError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  router.post("/parcels/:id/deliver", requireAuth(pool), requirePermission(pool, "logistics.manage"), async (req: Request, res: Response) => {
    try {
      const parcel = await markParcelDelivered(pool, requireParam(req, "id"));
      await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "parcel.delivered", entityType: "parcel", entityId: parcel.id, ipAddress: getIp(req), sessionId: req.sessionId });
      res.json(parcel);
    } catch (err) {
      if (err instanceof ParcelNotInExpectedStatusError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  return router;
}
