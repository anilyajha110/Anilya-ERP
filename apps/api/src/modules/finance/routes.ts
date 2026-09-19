import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { requireAuth, requirePermission } from "../identity/rbac.js";
import { generateInvoice, getInvoiceByOrderId, getInvoiceById, OrderNotDeliveredError, InvoiceAlreadyExistsError } from "./invoice.service.js";
import { createOtpRequest, verifyOtpRequest, OtpExpiredError, OtpAttemptsExceededError, OtpIncorrectError, OtpAlreadyVerifiedError } from "../identity/otp.service.js";
import { logActivity } from "../identity/audit.service.js";
import { getOrderById } from "../orders/order.service.js";

function getIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}
function requireParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string") throw new Error(`Expected route param '${name}' to be present`);
  return value;
}

export function createFinanceRouter(pool: pg.Pool): Router {
  const router = Router();

  // --- Staff-facing generation ---

  router.post("/orders/:orderId/invoice", requireAuth(pool), requirePermission(pool, "invoices.generate"), async (req: Request, res: Response) => {
    const { orgPrefix } = req.body ?? {};
    if (!orgPrefix) return res.status(400).json({ error: "orgPrefix is required" });
    try {
      const invoice = await generateInvoice(pool, requireParam(req, "orderId"), orgPrefix, req.identity!.id);
      await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "invoice.generated", entityType: "invoice", entityId: invoice.id, ipAddress: getIp(req), sessionId: req.sessionId, remarks: invoice.invoice_number });
      res.status(201).json(invoice);
    } catch (err) {
      if (err instanceof OrderNotDeliveredError || err instanceof InvoiceAlreadyExistsError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  router.get("/orders/:orderId/invoice", requireAuth(pool), requirePermission(pool, "invoices.read"), async (req: Request, res: Response) => {
    const invoice = await getInvoiceByOrderId(pool, requireParam(req, "orderId"));
    if (!invoice) return res.status(404).json({ error: "No invoice for this order" });
    res.json(invoice);
  });

  // --- Customer self-service, OTP-protected (FIN-002) ---
  // Ownership is checked against the VERIFIED session's own identity —
  // never a body/query parameter — same discipline as every other
  // self-service route in this project (Phase 3/4's /me routes). The
  // OTP always goes to the customer's own REGISTERED mobile
  // (req.identity.phone), never a number supplied in the request.

  router.post("/invoices/:id/download/request-otp", requireAuth(pool), async (req: Request, res: Response) => {
    const invoice = await getInvoiceById(pool, requireParam(req, "id"));
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    const order = await getOrderById(pool, invoice.order_id);
    if (!order || order.customer_identity_id !== req.identity!.id) return res.status(403).json({ error: "This invoice does not belong to your account" });
    if (!req.identity!.phone) return res.status(409).json({ error: "No registered mobile number on file for OTP delivery" });

    const otp = await createOtpRequest(pool, { identityId: req.identity!.id, purpose: "invoice_download", channels: [{ channel: "sms", destination: req.identity!.phone }] });
    await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "invoice.download_otp_requested", entityType: "invoice", entityId: invoice.id, ipAddress: getIp(req), sessionId: req.sessionId });
    // rawCode returned ONLY because no real SMS gateway is connected yet — same documented pattern throughout this project.
    res.json({ otpRequestId: otp.otpRequestId, expiresAt: otp.expiresAt, demoOtp: otp.rawCode });
  });

  router.post("/invoices/:id/download/verify-otp", requireAuth(pool), async (req: Request, res: Response) => {
    const { otpRequestId, code } = req.body ?? {};
    if (!otpRequestId || !code) return res.status(400).json({ error: "otpRequestId and code are required" });

    const invoice = await getInvoiceById(pool, requireParam(req, "id"));
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    const order = await getOrderById(pool, invoice.order_id);
    if (!order || order.customer_identity_id !== req.identity!.id) return res.status(403).json({ error: "This invoice does not belong to your account" });

    try {
      await verifyOtpRequest(pool, otpRequestId, code);
      await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "invoice.downloaded", entityType: "invoice", entityId: invoice.id, ipAddress: getIp(req), sessionId: req.sessionId });
      res.json(invoice); // stands in for a real file download — no object storage exists yet in this build
    } catch (err) {
      if (err instanceof OtpIncorrectError) return res.status(401).json({ error: err.message, attemptsRemaining: err.attemptsRemaining });
      if (err instanceof OtpExpiredError || err instanceof OtpAttemptsExceededError || err instanceof OtpAlreadyVerifiedError) return res.status(401).json({ error: err.message });
      throw err;
    }
  });

  return router;
}
