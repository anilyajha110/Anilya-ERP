import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { requireAuth, requirePermission } from "../identity/rbac.js";
import { createProduct, mapExternalId } from "./product.service.js";
import { createWarehouse, setDefaultWarehouse, NoDefaultWarehouseError } from "./warehouse.service.js";
import { reserveStock, releaseReservation, consumeReservation, getStock, getLedger, InsufficientStockError, ReservationNotActiveError } from "./inventory.service.js";
import { processInboundEvent } from "./events.service.js";
import { logActivity } from "../identity/audit.service.js";

function getIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}
function requireParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string") throw new Error(`Expected route param '${name}' to be present`);
  return value;
}

export function createInventoryRouter(pool: pg.Pool): Router {
  const router = Router();

  router.post("/inventory/products", requireAuth(pool), requirePermission(pool, "inventory.manage"), async (req: Request, res: Response) => {
    const { sku, name } = req.body ?? {};
    if (!sku || !name) return res.status(400).json({ error: "sku and name are required" });
    const product = await createProduct(pool, { organizationId: req.identity!.organization_id, sku, name });
    res.status(201).json(product);
  });

  router.post("/inventory/products/:id/map-external", requireAuth(pool), requirePermission(pool, "inventory.manage"), async (req: Request, res: Response) => {
    const { source, externalId } = req.body ?? {};
    if (!source || !externalId) return res.status(400).json({ error: "source and externalId are required" });
    await mapExternalId(pool, { organizationId: req.identity!.organization_id, productId: requireParam(req, "id"), source, externalId });
    res.status(201).json({ mapped: true });
  });

  router.post("/inventory/warehouses", requireAuth(pool), requirePermission(pool, "inventory.manage"), async (req: Request, res: Response) => {
    const { name, city } = req.body ?? {};
    if (!name) return res.status(400).json({ error: "name is required" });
    const warehouse = await createWarehouse(pool, { organizationId: req.identity!.organization_id, name, city });
    res.status(201).json(warehouse);
  });

  router.post("/inventory/warehouses/:id/set-default", requireAuth(pool), requirePermission(pool, "inventory.manage"), async (req: Request, res: Response) => {
    await setDefaultWarehouse(pool, req.identity!.organization_id, requireParam(req, "id"));
    await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "inventory.default_warehouse_set", entityType: "inventory_warehouse", entityId: requireParam(req, "id"), ipAddress: getIp(req), sessionId: req.sessionId });
    res.json({ updated: true });
  });

  // INV-002: idempotent — a real 200/201 distinction tells the caller
  // whether this exact event actually did anything this time.
  router.post("/inventory/events", requireAuth(pool), requirePermission(pool, "inventory.manage"), async (req: Request, res: Response) => {
    const { eventId, eventType, source, externalProductId, sku, productName, quantity, warehouseId } = req.body ?? {};
    if (!eventId || !eventType || !source || !externalProductId || !sku || !productName || typeof quantity !== "number") {
      return res.status(400).json({ error: "eventId, eventType, source, externalProductId, sku, productName, and quantity are required" });
    }
    try {
      const { wasNew } = await processInboundEvent(pool, { organizationId: req.identity!.organization_id, eventId, eventType, source, externalProductId, sku, productName, quantity, warehouseId, createdBy: req.identity!.id });
      res.status(wasNew ? 201 : 200).json({ wasNew });
    } catch (err) {
      if (err instanceof NoDefaultWarehouseError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  router.post("/inventory/reservations", requireAuth(pool), requirePermission(pool, "inventory.reserve"), async (req: Request, res: Response) => {
    const { productId, warehouseId, orderId, quantity } = req.body ?? {};
    if (!productId || !warehouseId || typeof quantity !== "number") return res.status(400).json({ error: "productId, warehouseId, and quantity are required" });
    try {
      const reservation = await reserveStock(pool, { organizationId: req.identity!.organization_id, productId, warehouseId, orderId, quantity, createdBy: req.identity!.id });
      await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "inventory.reserved", entityType: "inventory_reservation", entityId: reservation.id, ipAddress: getIp(req), sessionId: req.sessionId, newValue: quantity });
      res.status(201).json(reservation);
    } catch (err) {
      if (err instanceof InsufficientStockError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  router.post("/inventory/reservations/:id/release", requireAuth(pool), requirePermission(pool, "inventory.reserve"), async (req: Request, res: Response) => {
    try {
      await releaseReservation(pool, requireParam(req, "id"));
      await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "inventory.released", entityType: "inventory_reservation", entityId: requireParam(req, "id"), ipAddress: getIp(req), sessionId: req.sessionId });
      res.json({ released: true });
    } catch (err) {
      if (err instanceof ReservationNotActiveError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  router.post("/inventory/reservations/:id/consume", requireAuth(pool), requirePermission(pool, "inventory.reserve"), async (req: Request, res: Response) => {
    try {
      await consumeReservation(pool, requireParam(req, "id"));
      await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "inventory.consumed", entityType: "inventory_reservation", entityId: requireParam(req, "id"), ipAddress: getIp(req), sessionId: req.sessionId });
      res.json({ consumed: true });
    } catch (err) {
      if (err instanceof ReservationNotActiveError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  router.get("/inventory/stock", requireAuth(pool), requirePermission(pool, "inventory.read"), async (req: Request, res: Response) => {
    const { productId, warehouseId } = req.query;
    if (typeof productId !== "string" || typeof warehouseId !== "string") return res.status(400).json({ error: "productId and warehouseId query params are required" });
    res.json(await getStock(pool, productId, warehouseId));
  });

  router.get("/inventory/ledger", requireAuth(pool), requirePermission(pool, "inventory.read"), async (req: Request, res: Response) => {
    const { productId, warehouseId } = req.query;
    if (typeof productId !== "string" || typeof warehouseId !== "string") return res.status(400).json({ error: "productId and warehouseId query params are required" });
    res.json(await getLedger(pool, productId, warehouseId));
  });

  return router;
}
