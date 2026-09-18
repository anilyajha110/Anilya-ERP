import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { requireAuth, requirePermission } from "../identity/rbac.js";
import { recordPayable, recordPayment, getLedger, getCurrentBalance } from "./operator-ledger.service.js";
import { logActivity } from "../identity/audit.service.js";

function getIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}
function requireParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string") throw new Error(`Expected route param '${name}' to be present`);
  return value;
}

export function createOperatorLedgerRouter(pool: pg.Pool): Router {
  const router = Router();

  // The ERP does NO rate math — this endpoint exists purely to record
  // whatever final amount AMS reports for a completed unit of work.
  router.post("/operators/:id/ledger/payable", requireAuth(pool), requirePermission(pool, "operatorledger.write"), async (req: Request, res: Response) => {
    const { amount, externalReference, remarks } = req.body ?? {};
    if (typeof amount !== "number" || !externalReference) return res.status(400).json({ error: "amount (number) and externalReference are required" });
    const { entry, wasNew } = await recordPayable(pool, { organizationId: req.identity!.organization_id, operatorIdentityId: requireParam(req, "id"), amount, externalReference, remarks, createdBy: req.identity!.id });
    if (wasNew) {
      await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "operatorledger.payable_recorded", entityType: "operator_ledger", entityId: requireParam(req, "id"), ipAddress: getIp(req), sessionId: req.sessionId, newValue: amount, remarks: `ledger row #${entry.id} — ${externalReference}` });
    }
    res.status(wasNew ? 201 : 200).json({ ...entry, wasNew });
  });

  router.post("/operators/:id/ledger/payment", requireAuth(pool), requirePermission(pool, "operatorledger.write"), async (req: Request, res: Response) => {
    const { amount, remarks } = req.body ?? {};
    if (typeof amount !== "number") return res.status(400).json({ error: "amount (number) is required" });
    const entry = await recordPayment(pool, { organizationId: req.identity!.organization_id, operatorIdentityId: requireParam(req, "id"), amount, remarks, createdBy: req.identity!.id });
    await logActivity(pool, { organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "operatorledger.payment_recorded", entityType: "operator_ledger", entityId: requireParam(req, "id"), ipAddress: getIp(req), sessionId: req.sessionId, newValue: amount, remarks: `ledger row #${entry.id}` });
    res.status(201).json(entry);
  });

  router.get("/operators/:id/ledger", requireAuth(pool), requirePermission(pool, "operatorledger.read"), async (req: Request, res: Response) => {
    const [entries, balance] = await Promise.all([getLedger(pool, requireParam(req, "id")), getCurrentBalance(pool, requireParam(req, "id"))]);
    res.json({ entries, currentBalance: balance });
  });

  return router;
}
