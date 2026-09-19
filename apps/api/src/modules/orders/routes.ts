import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { requireAuth, requirePermission } from "../identity/rbac.js";
import { createOrder, getOrderById, getOrderByTrackingToken, listOrdersForCustomer, transitionOrder, ArtworkNotPrintReadyError, IncompleteJobsError, type Order } from "./order.service.js";
import { InvalidTransitionError } from "./state-machine.js";
import { logActivity } from "../identity/audit.service.js";

function getIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}
function requireParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string") throw new Error(`Expected route param '${name}' to be present`);
  return value;
}

// Only what a stranger holding the link should ever see. Deliberately
// NEVER includes phone/email — carried forward from the prototype's
// own hard requirement (ORD-005), verified there by grepping rendered
// output for phone digits, verified here by simply never selecting
// the column into this shape in the first place.
function publicTrackingView(order: Order) {
  return {
    displayOrderNumber: order.display_order_number,
    productName: order.product_name,
    stage: order.stage,
    shippingAddress: order.shipping_address,
    cancelledAt: order.cancelled_at,
  };
}

export function createOrdersRouter(pool: pg.Pool): Router {
  const router = Router();

  // --- Specific paths BEFORE /orders/:id — a parameterized route
  // registered first would otherwise swallow these (the exact bug
  // already found once in the CRM module's /customers/me). ---

  router.post("/orders/import", requireAuth(pool), requirePermission(pool, "orders.import"), async (req: Request, res: Response) => {
    const { idempotencyKey, orgPrefix, productName, orderValue, masterOrderId, shippingAddress, customerName, customerPhone, customerEmail, artworkIntent } = req.body ?? {};
    if (!idempotencyKey || !orgPrefix || !productName || !customerName) {
      return res.status(400).json({ error: "idempotencyKey, orgPrefix, productName, and customerName are required" });
    }
    if (!["attachment", "no", "blank"].includes(artworkIntent)) {
      return res.status(400).json({ error: "artworkIntent must be one of: attachment, no, blank" });
    }
    const { order, wasNew } = await createOrder(pool, {
      organizationId: req.identity!.organization_id, idempotencyKey, orgPrefix, productName, orderValue, masterOrderId, shippingAddress,
      customerName, customerPhone, customerEmail, createdBy: req.identity!.id, artworkIntent,
    });
    if (wasNew) {
      await logActivity(pool, {
        organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "order.imported",
        entityType: "order", entityId: order.id, ipAddress: getIp(req), sessionId: req.sessionId,
        remarks: `Order ${order.display_order_number} imported`,
      });
    }
    res.status(wasNew ? 201 : 200).json({ ...order, wasNew });
  });

  router.get("/orders/me", requireAuth(pool), async (req: Request, res: Response) => {
    if (req.identity!.identity_type !== "customer") return res.status(403).json({ error: "This endpoint is for customer accounts only" });
    res.json(await listOrdersForCustomer(pool, req.identity!.id));
  });

  // --- Parameterized routes ---

  router.get("/orders/:id", requireAuth(pool), requirePermission(pool, "orders.read"), async (req: Request, res: Response) => {
    const order = await getOrderById(pool, requireParam(req, "id"));
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json(order);
  });

  router.post("/orders/:id/:action", requireAuth(pool), requirePermission(pool, "orders.write"), async (req: Request, res: Response) => {
    const action = requireParam(req, "action");
    const { reason } = req.body ?? {};
    if (action === "cancel" && !reason) return res.status(400).json({ error: "reason is required to cancel an order" });

    try {
      const before = await getOrderById(pool, requireParam(req, "id"));
      const order = await transitionOrder(pool, requireParam(req, "id"), action, { cancellationReason: reason });
      await logActivity(pool, {
        organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: `order.${action}`,
        entityType: "order", entityId: order.id, oldValue: before?.stage, newValue: order.stage,
        remarks: reason ? `${action}: ${reason}` : action, ipAddress: getIp(req), sessionId: req.sessionId,
      });
      res.json(order);
    } catch (err) {
      if (err instanceof InvalidTransitionError || err instanceof ArtworkNotPrintReadyError || err instanceof IncompleteJobsError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  return router;
}

// A SEPARATE router, deliberately never mounted behind requireAuth —
// this is the public tracking link a customer opens with no login at
// all. Mounted at the bare /track path (not under /api) to match the
// short, shareable link shape the prototype's own tracking URLs used.
export function createPublicTrackingRouter(pool: pg.Pool): Router {
  const router = Router();
  router.get("/track/:token", async (req: Request, res: Response) => {
    const order = await getOrderByTrackingToken(pool, requireParam(req, "token"));
    if (!order) return res.status(404).json({ error: "Tracking link not found" });
    res.json(publicTrackingView(order));
  });
  return router;
}
