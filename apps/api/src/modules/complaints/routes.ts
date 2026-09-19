import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { requireAuth, requirePermission } from "../identity/rbac.js";
import { raiseTicket, getTicketById, listTicketsForOrder, updateTicketStatus, addEvidence, getEvidence, resolveTicket, TicketNotResolvableError, RefundAmountRequiredError, type ComplaintTicket } from "./complaint.service.js";
import { getOrderById } from "../orders/order.service.js";
import { logActivity } from "../identity/audit.service.js";

function getIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}
function requireParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string") throw new Error(`Expected route param '${name}' to be present`);
  return value;
}

const VALID_STATUSES: ComplaintTicket["status"][] = ["raised", "under_review", "evidence_required", "resolution_pending", "resolved", "rejected", "closed"];

export function createComplaintsRouter(pool: pg.Pool): Router {
  const router = Router();

  // CMP-002: plain list, not a single lookup — one order can have many tickets.
  router.post("/orders/:orderId/complaints", requireAuth(pool), async (req: Request, res: Response) => {
    const order = await getOrderById(pool, requireParam(req, "orderId"));
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (req.identity!.identity_type === "customer" && order.customer_identity_id !== req.identity!.id) {
      return res.status(403).json({ error: "This order does not belong to your account" });
    }
    const { category, description, requestedResolution } = req.body ?? {};
    if (!category || !description) return res.status(400).json({ error: "category and description are required" });

    const ticket = await raiseTicket(pool, { organizationId: order.organization_id, orderId: order.id, customerIdentityId: order.customer_identity_id, category, description, requestedResolution });
    await logActivity(pool, { organizationId: order.organization_id, actorIdentityId: req.identity!.id, actionType: "complaint.raised", entityType: "complaint_ticket", entityId: ticket.id, ipAddress: getIp(req), sessionId: req.sessionId, remarks: category });
    res.status(201).json(ticket);
  });

  router.get("/orders/:orderId/complaints", requireAuth(pool), requirePermission(pool, "complaints.read"), async (req: Request, res: Response) => {
    res.json(await listTicketsForOrder(pool, requireParam(req, "orderId")));
  });

  router.get("/complaints/:id", requireAuth(pool), requirePermission(pool, "complaints.read"), async (req: Request, res: Response) => {
    const ticket = await getTicketById(pool, requireParam(req, "id"));
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    res.json(ticket);
  });

  router.post("/complaints/:id/status", requireAuth(pool), requirePermission(pool, "complaints.manage"), async (req: Request, res: Response) => {
    const { status } = req.body ?? {};
    if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` });
    const before = await getTicketById(pool, requireParam(req, "id"));
    const ticket = await updateTicketStatus(pool, requireParam(req, "id"), status);
    await logActivity(pool, { organizationId: ticket.organization_id, actorIdentityId: req.identity!.id, actionType: "complaint.status_changed", entityType: "complaint_ticket", entityId: ticket.id, oldValue: before?.status, newValue: status, ipAddress: getIp(req), sessionId: req.sessionId });
    res.json(ticket);
  });

  // CMP-004/005: evidence always attaches to THIS ticket — never spawns a new one.
  router.post("/complaints/:id/evidence", requireAuth(pool), async (req: Request, res: Response) => {
    const ticket = await getTicketById(pool, requireParam(req, "id"));
    if (!ticket) return res.status(404).json({ error: "Ticket not found" });
    if (req.identity!.identity_type === "customer" && ticket.customer_identity_id !== req.identity!.id) {
      return res.status(403).json({ error: "This ticket does not belong to your account" });
    }
    const { fileReference } = req.body ?? {};
    if (!fileReference) return res.status(400).json({ error: "fileReference is required" });

    const { evidenceId } = await addEvidence(pool, ticket.id, fileReference, req.identity!.id);
    await logActivity(pool, { organizationId: ticket.organization_id, actorIdentityId: req.identity!.id, actionType: "complaint.evidence_added", entityType: "complaint_ticket", entityId: ticket.id, ipAddress: getIp(req), sessionId: req.sessionId, remarks: fileReference });
    res.status(201).json({ evidenceId });
  });

  router.get("/complaints/:id/evidence", requireAuth(pool), requirePermission(pool, "complaints.read"), async (req: Request, res: Response) => {
    res.json(await getEvidence(pool, requireParam(req, "id")));
  });

  // CMP-003 — Manager-only, its own permission separate from
  // complaints.manage (the same "narrower permission for the most
  // consequential action" pattern as Phase 5's print-approval and
  // Phase 7's escalation resolution).
  router.post("/complaints/:id/resolve", requireAuth(pool), requirePermission(pool, "complaints.resolve"), async (req: Request, res: Response) => {
    const { resolutionType, resolutionNotes, refundAmount, orgPrefix } = req.body ?? {};
    try {
      const ticket = await resolveTicket(pool, { ticketId: requireParam(req, "id"), resolutionType, resolutionNotes, refundAmount, orgPrefix, resolvedBy: req.identity!.id });
      await logActivity(pool, { organizationId: ticket.organization_id, actorIdentityId: req.identity!.id, actionType: "complaint.resolved", entityType: "complaint_ticket", entityId: ticket.id, newValue: resolutionType, ipAddress: getIp(req), sessionId: req.sessionId, remarks: resolutionNotes });
      res.json(ticket);
    } catch (err) {
      if (err instanceof TicketNotResolvableError || err instanceof RefundAmountRequiredError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  return router;
}
