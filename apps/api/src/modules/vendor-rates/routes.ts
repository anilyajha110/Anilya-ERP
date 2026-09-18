import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { requireAuth, requirePermission } from "../identity/rbac.js";
import { setMasterRate, getMasterRate, submitQuote, approveQuote, rejectQuote, listPendingQuotes, QuoteNotPendingError } from "./vendor-rate.service.js";
import { logActivity } from "../identity/audit.service.js";

function getIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}
function requireParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string") throw new Error(`Expected route param '${name}' to be present`);
  return value;
}

export function createVendorRateRouter(pool: pg.Pool): Router {
  const router = Router();

  // Setting the master rate is its OWN, separately-permissioned,
  // deliberate action (JOB-006) — never a side effect of approving a quote.
  router.put("/vendor-rates/:category", requireAuth(pool), requirePermission(pool, "vendorrates.master.manage"), async (req: Request, res: Response) => {
    const { referenceRate } = req.body ?? {};
    if (typeof referenceRate !== "number") return res.status(400).json({ error: "referenceRate (number) is required" });
    const rate = await setMasterRate(pool, req.identity!.organization_id, requireParam(req, "category"), referenceRate, req.identity!.id);
    await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "vendorrate.master_updated", entityType: "vendor_master_rate", entityId: rate.id, ipAddress: getIp(req), sessionId: req.sessionId, newValue: referenceRate, remarks: `category=${requireParam(req, "category")}` });
    res.json(rate);
  });

  router.get("/vendor-rates/:category", requireAuth(pool), requirePermission(pool, "vendorrates.read"), async (req: Request, res: Response) => {
    const rate = await getMasterRate(pool, req.identity!.organization_id, requireParam(req, "category"));
    if (!rate) return res.status(404).json({ error: "No master rate on file for this category" });
    res.json(rate);
  });

  router.post("/vendor-rates/quotes", requireAuth(pool), requirePermission(pool, "vendorrates.quote.submit"), async (req: Request, res: Response) => {
    const { jobId, quotedRate, category } = req.body ?? {};
    if (!jobId || typeof quotedRate !== "number" || !category) return res.status(400).json({ error: "jobId, quotedRate (number), and category are required" });
    const quote = await submitQuote(pool, { organizationId: req.identity!.organization_id, jobId, partnerIdentityId: req.identity!.id, quotedRate, category });
    await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "vendorrate.quote_submitted", entityType: "vendor_rate_quote", entityId: quote.id, ipAddress: getIp(req), sessionId: req.sessionId, remarks: quote.status });
    res.status(201).json(quote);
  });

  router.get("/vendor-rates/quotes/pending", requireAuth(pool), requirePermission(pool, "vendorrates.quote.approve"), async (req: Request, res: Response) => {
    res.json(await listPendingQuotes(pool, req.identity!.organization_id));
  });

  router.post("/vendor-rates/quotes/:id/approve", requireAuth(pool), requirePermission(pool, "vendorrates.quote.approve"), async (req: Request, res: Response) => {
    try {
      const quote = await approveQuote(pool, requireParam(req, "id"), req.identity!.id);
      await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "vendorrate.quote_approved", entityType: "vendor_rate_quote", entityId: quote.id, ipAddress: getIp(req), sessionId: req.sessionId });
      res.json(quote);
    } catch (err) {
      if (err instanceof QuoteNotPendingError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  router.post("/vendor-rates/quotes/:id/reject", requireAuth(pool), requirePermission(pool, "vendorrates.quote.approve"), async (req: Request, res: Response) => {
    try {
      const quote = await rejectQuote(pool, requireParam(req, "id"), req.identity!.id);
      await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "vendorrate.quote_rejected", entityType: "vendor_rate_quote", entityId: quote.id, ipAddress: getIp(req), sessionId: req.sessionId });
      res.json(quote);
    } catch (err) {
      if (err instanceof QuoteNotPendingError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  return router;
}
