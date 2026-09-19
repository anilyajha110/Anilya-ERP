import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { requireAuth, requirePermission } from "../identity/rbac.js";
import { createNotificationType, setRoutingRule, removeRoutingRule, notify, getNotificationById, listNotificationsForRecipient, NoRoutingRuleError } from "./notification.service.js";
import { logActivity } from "../identity/audit.service.js";

function getIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}
function requireParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string") throw new Error(`Expected route param '${name}' to be present`);
  return value;
}

export function createNotificationsRouter(pool: pg.Pool): Router {
  const router = Router();

  router.post("/notifications/types", requireAuth(pool), requirePermission(pool, "notifications.manage"), async (req: Request, res: Response) => {
    const { key, description } = req.body ?? {};
    if (!key || !description) return res.status(400).json({ error: "key and description are required" });
    const type = await createNotificationType(pool, { organizationId: req.identity!.organization_id, key, description });
    res.status(201).json(type);
  });

  router.put("/notifications/routing-rules", requireAuth(pool), requirePermission(pool, "notifications.manage"), async (req: Request, res: Response) => {
    const { notificationTypeId, recipientRole, channel } = req.body ?? {};
    if (!notificationTypeId || !recipientRole || !channel) return res.status(400).json({ error: "notificationTypeId, recipientRole, and channel are required" });
    await setRoutingRule(pool, { organizationId: req.identity!.organization_id, notificationTypeId, recipientRole, channel });
    await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "notifications.routing_rule_set", entityType: "notification_type", entityId: notificationTypeId, ipAddress: getIp(req), sessionId: req.sessionId, remarks: `${recipientRole} -> ${channel}` });
    res.json({ updated: true });
  });

  router.delete("/notifications/routing-rules", requireAuth(pool), requirePermission(pool, "notifications.manage"), async (req: Request, res: Response) => {
    const { notificationTypeId, recipientRole, channel } = req.body ?? {};
    if (!notificationTypeId || !recipientRole || !channel) return res.status(400).json({ error: "notificationTypeId, recipientRole, and channel are required" });
    await removeRoutingRule(pool, { organizationId: req.identity!.organization_id, notificationTypeId, recipientRole, channel });
    await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "notifications.routing_rule_removed", entityType: "notification_type", entityId: notificationTypeId, ipAddress: getIp(req), sessionId: req.sessionId, remarks: `${recipientRole} -> ${channel}` });
    res.json({ removed: true });
  });

  router.post("/notifications/send", requireAuth(pool), requirePermission(pool, "notifications.send"), async (req: Request, res: Response) => {
    const { typeKey, recipientIdentityId, recipientRole, entityType, entityId } = req.body ?? {};
    if (!typeKey || !recipientIdentityId || !recipientRole) return res.status(400).json({ error: "typeKey, recipientIdentityId, and recipientRole are required" });
    try {
      const notification = await notify(pool, { organizationId: req.identity!.organization_id, typeKey, recipientIdentityId, recipientRole, entityType, entityId });
      res.status(201).json(notification);
    } catch (err) {
      if (err instanceof NoRoutingRuleError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  router.get("/notifications/me", requireAuth(pool), async (req: Request, res: Response) => {
    res.json(await listNotificationsForRecipient(pool, req.identity!.id));
  });

  router.get("/notifications/:id", requireAuth(pool), requirePermission(pool, "notifications.manage"), async (req: Request, res: Response) => {
    const notification = await getNotificationById(pool, requireParam(req, "id"));
    if (!notification) return res.status(404).json({ error: "Notification not found" });
    res.json(notification);
  });

  return router;
}
