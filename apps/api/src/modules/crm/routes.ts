import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { requireAuth, requirePermission } from "../identity/rbac.js";
import { findOrCreateCustomer, getCustomerById, updateBillingProfile } from "./customer.service.js";
import { addLedgerEntry, getLedger, getCurrentBalance } from "./ledger.service.js";
import { previewImport, commitImport, rollbackImport, BatchAlreadyRolledBackError, BatchNotCommittedError, type ImportRow } from "./import.service.js";
import { logActivity } from "../identity/audit.service.js";

function getIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}

// Express types req.params[key] as string | undefined at best (and
// TypeScript's own indexed-access strictness widens it further) — but
// a route defined with `:id` guarantees a single string at runtime.
// This makes that guarantee explicit instead of scattering `!`
// assertions (or worse, unchecked casts) through every handler.
function requireParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string") throw new Error(`Expected route param '${name}' to be present`);
  return value;
}

export function createCrmRouter(pool: pg.Pool): Router {
  const router = Router();

  // --- Customer self-service (CRM-005) -----------------------------------
  // Registered BEFORE the /customers/:id routes below — Express matches
  // routes in registration order, and a parameterized /customers/:id
  // would otherwise swallow "/customers/me" itself, treating "me" as an
  // :id value (exactly the class of bug already found once before in
  // this project's Inventory module — /products/by-external vs
  // /products/:id). Caught live here by the automated test, not assumed.
  //
  // Deliberately reads req.identity.id — the customer's OWN verified
  // session — never a :id route parameter. A customer can never view
  // another customer's data by guessing/changing an id in the URL,
  // because there is no id in this URL at all.

  router.get("/customers/me", requireAuth(pool), async (req: Request, res: Response) => {
    if (req.identity!.identity_type !== "customer") return res.status(403).json({ error: "This endpoint is for customer accounts only" });
    const customer = await getCustomerById(pool, req.identity!.id);
    res.json(customer);
  });

  router.get("/customers/me/ledger", requireAuth(pool), async (req: Request, res: Response) => {
    if (req.identity!.identity_type !== "customer") return res.status(403).json({ error: "This endpoint is for customer accounts only" });
    const [entries, balance] = await Promise.all([getLedger(pool, req.identity!.id), getCurrentBalance(pool, req.identity!.id)]);
    res.json({ entries, currentBalance: balance });
  });

  // --- Staff-facing: create/find, view, bill, adjust -------------------

  router.post("/customers", requireAuth(pool), requirePermission(pool, "customers.write"), async (req: Request, res: Response) => {
    const { displayName, phone, email } = req.body ?? {};
    if (!displayName) return res.status(400).json({ error: "displayName is required" });
    const { customer, wasNew } = await findOrCreateCustomer(pool, { organizationId: req.identity!.organization_id, displayName, phone, email });
    await logActivity(pool, {
      organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actorRole: "staff",
      actionType: wasNew ? "customer.created" : "customer.matched_existing", entityType: "identity", entityId: customer.identity_id,
      ipAddress: getIp(req), sessionId: req.sessionId, remarks: `${displayName}${wasNew ? " created as new customer" : " matched to existing customer"}`,
    });
    res.status(wasNew ? 201 : 200).json({ ...customer, wasNew });
  });

  router.get("/customers/:id", requireAuth(pool), requirePermission(pool, "customers.read"), async (req: Request, res: Response) => {
    const customer = await getCustomerById(pool, requireParam(req, "id"));
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    res.json(customer);
  });

  router.patch("/customers/:id/billing", requireAuth(pool), requirePermission(pool, "customers.write"), async (req: Request, res: Response) => {
    await updateBillingProfile(pool, requireParam(req, "id"), req.body ?? {});
    await logActivity(pool, {
      organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id,
      actionType: "customer.billing_updated", entityType: "identity", entityId: requireParam(req, "id"), ipAddress: getIp(req), sessionId: req.sessionId,
    });
    res.json({ updated: true });
  });

  router.get("/customers/:id/ledger", requireAuth(pool), requirePermission(pool, "customers.read"), async (req: Request, res: Response) => {
    const [entries, balance] = await Promise.all([getLedger(pool, requireParam(req, "id")), getCurrentBalance(pool, requireParam(req, "id"))]);
    res.json({ entries, currentBalance: balance });
  });

  // Manual adjustment — the only sanctioned way to correct a ledger
  // mistake (a new offsetting row, never an edit) — permission-gated
  // separately from ordinary read/write, since this moves money.
  router.post("/customers/:id/ledger/adjustment", requireAuth(pool), requirePermission(pool, "customers.ledger.adjust"), async (req: Request, res: Response) => {
    const { amount, remarks } = req.body ?? {};
    if (amount == null) return res.status(400).json({ error: "amount is required (positive or negative)" });
    const entry = await addLedgerEntry(pool, {
      organizationId: req.identity!.organization_id, customerIdentityId: requireParam(req, "id"), particular: "adjustment",
      adjustment: Number(amount), remarks, createdBy: req.identity!.id,
    });
    await logActivity(pool, {
      organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id,
      actionType: "customer.ledger.adjustment", entityType: "customer_ledger", entityId: requireParam(req, "id"),
      oldValue: entry.previous_balance, newValue: entry.final_balance, remarks: `Ledger entry ${entry.id}: ${remarks ?? ""}`, ipAddress: getIp(req), sessionId: req.sessionId,
    });
    res.status(201).json(entry);
  });

  // --- Import: preview / commit / rollback (CRM-004) --------------------

  router.post("/customers/import/preview", requireAuth(pool), requirePermission(pool, "customers.import"), async (req: Request, res: Response) => {
    const rows: ImportRow[] = req.body?.rows ?? [];
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: "rows must be a non-empty array" });
    const preview = await previewImport(pool, req.identity!.organization_id, rows);
    res.json({ preview, willCreate: preview.filter((p) => p.matchType === "new").length, willMatch: preview.filter((p) => p.matchType === "existing").length });
  });

  router.post("/customers/import/commit", requireAuth(pool), requirePermission(pool, "customers.import"), async (req: Request, res: Response) => {
    const rows: ImportRow[] = req.body?.rows ?? [];
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: "rows must be a non-empty array" });
    const result = await commitImport(pool, req.identity!.organization_id, rows, req.identity!.id);
    await logActivity(pool, {
      organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id,
      actionType: "customer.import.committed", entityType: "import_batch", entityId: result.batchId,
      ipAddress: getIp(req), sessionId: req.sessionId, remarks: `${result.created} created, ${result.matched} matched`,
    });
    res.status(201).json(result);
  });

  router.post("/customers/import/:batchId/rollback", requireAuth(pool), requirePermission(pool, "customers.import"), async (req: Request, res: Response) => {
    try {
      const result = await rollbackImport(pool, requireParam(req, "batchId"));
      await logActivity(pool, {
        organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id,
        actionType: "customer.import.rolled_back", entityType: "import_batch", entityId: requireParam(req, "batchId"),
        ipAddress: getIp(req), sessionId: req.sessionId, remarks: `${result.deletedCustomers} newly-created customer(s) removed; pre-existing matches untouched`,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof BatchAlreadyRolledBackError || err instanceof BatchNotCommittedError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  return router;
}
