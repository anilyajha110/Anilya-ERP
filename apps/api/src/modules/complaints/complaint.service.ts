import { randomUUID } from "node:crypto";
import type pg from "pg";
import { getOrderById, createOrder } from "../orders/order.service.js";
import { addLedgerEntry } from "../crm/ledger.service.js";

export interface ComplaintTicket {
  id: string;
  organization_id: string;
  order_id: string;
  customer_identity_id: string;
  category: string;
  description: string;
  requested_resolution: string | null;
  status: "raised" | "under_review" | "evidence_required" | "resolution_pending" | "resolved" | "rejected" | "closed";
  resolution_type: "refund" | "replacement" | "credit" | "rejected" | "other" | null;
  resolution_notes: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  replacement_order_id: string | null;
  created_at: Date;
}

export class TicketNotResolvableError extends Error {
  constructor(status: string) { super(`Cannot resolve a ticket in status '${status}'`); this.name = "TicketNotResolvableError"; }
}
export class RefundAmountRequiredError extends Error {
  constructor() { super("refundAmount is required for a 'refund' resolution"); this.name = "RefundAmountRequiredError"; }
}

// CMP-001: raising a ticket is always an explicit customer action —
// nothing anywhere in this codebase auto-creates one from a low
// Feedback rating (Feedback isn't even part of this schema; the two
// are deliberately unconnected).
export async function raiseTicket(
  pool: pg.Pool,
  params: { organizationId: string; orderId: string; customerIdentityId: string; category: string; description: string; requestedResolution?: string }
): Promise<ComplaintTicket> {
  const { rows } = await pool.query<ComplaintTicket>(
    `INSERT INTO complaint_tickets (organization_id, order_id, customer_identity_id, category, description, requested_resolution)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [params.organizationId, params.orderId, params.customerIdentityId, params.category, params.description, params.requestedResolution ?? null]
  );
  return rows[0]!;
}

export async function getTicketById(pool: pg.Pool, id: string): Promise<ComplaintTicket | null> {
  const { rows } = await pool.query<ComplaintTicket>("SELECT * FROM complaint_tickets WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function listTicketsForOrder(pool: pg.Pool, orderId: string): Promise<ComplaintTicket[]> {
  // CMP-002: one order can have many tickets — this is a plain list,
  // never a single "the ticket for this order" lookup.
  const { rows } = await pool.query<ComplaintTicket>("SELECT * FROM complaint_tickets WHERE order_id = $1 ORDER BY created_at", [orderId]);
  return rows;
}

export async function updateTicketStatus(pool: pg.Pool, ticketId: string, status: ComplaintTicket["status"]): Promise<ComplaintTicket> {
  const { rows } = await pool.query<ComplaintTicket>(
    "UPDATE complaint_tickets SET status = $1, updated_at = now() WHERE id = $2 RETURNING *", [status, ticketId]
  );
  if (!rows[0]) throw new Error("Ticket not found");
  return rows[0];
}

// CMP-004/005: evidence always attaches to THIS ticket, never spawns a
// new one. If the ticket was waiting specifically on evidence, adding
// it automatically moves the SAME ticket back to review — the ticket's
// identity never changes just because more was uploaded.
export async function addEvidence(pool: pg.Pool, ticketId: string, fileReference: string, uploadedBy?: string): Promise<{ evidenceId: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: ticketRows } = await client.query<ComplaintTicket>("SELECT * FROM complaint_tickets WHERE id = $1 FOR UPDATE", [ticketId]);
    if (!ticketRows[0]) throw new Error("Ticket not found");

    const evidenceId = randomUUID();
    await client.query(
      "INSERT INTO complaint_evidence (id, ticket_id, file_reference, uploaded_by) VALUES ($1, $2, $3, $4)",
      [evidenceId, ticketId, fileReference, uploadedBy ?? null]
    );
    if (ticketRows[0].status === "evidence_required") {
      await client.query("UPDATE complaint_tickets SET status = 'under_review', updated_at = now() WHERE id = $1", [ticketId]);
    }
    await client.query("COMMIT");
    return { evidenceId };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getEvidence(pool: pg.Pool, ticketId: string) {
  const { rows } = await pool.query("SELECT * FROM complaint_evidence WHERE ticket_id = $1 ORDER BY uploaded_at", [ticketId]);
  return rows;
}

// CMP-003 — the single most safety-critical function in this module.
// The customer's own requested_resolution is NEVER read here to decide
// anything; only an explicit, separately-permissioned Manager call
// reaches this function at all (enforced one layer up, in routes.ts,
// via requirePermission('complaints.resolve')).
export async function resolveTicket(
  pool: pg.Pool,
  params: {
    ticketId: string; resolutionType: NonNullable<ComplaintTicket["resolution_type"]>; resolutionNotes?: string; resolvedBy: string;
    refundAmount?: number; orgPrefix?: string; // orgPrefix required only for 'replacement'
  }
): Promise<ComplaintTicket> {
  const ticket = await getTicketById(pool, params.ticketId);
  if (!ticket) throw new Error("Ticket not found");
  if (!["raised", "under_review", "resolution_pending"].includes(ticket.status)) throw new TicketNotResolvableError(ticket.status);

  let replacementOrderId: string | null = null;

  if (params.resolutionType === "refund" || params.resolutionType === "credit") {
    if (typeof params.refundAmount !== "number") throw new RefundAmountRequiredError();
    // Reuses the EXISTING Customer Ledger (Phase 3) — never a parallel
    // payment-adjustment system. A negative adjustment reduces what the
    // customer owes, exactly the same mechanism a genuine payment
    // correction would use.
    await addLedgerEntry(pool, {
      organizationId: ticket.organization_id, customerIdentityId: ticket.customer_identity_id, particular: "adjustment",
      adjustment: -params.refundAmount, remarks: `Complaint ${ticket.id} resolution (${params.resolutionType}): ${params.resolutionNotes ?? ""}`, createdBy: params.resolvedBy,
    });
  }

  if (params.resolutionType === "replacement") {
    if (!params.orgPrefix) throw new Error("orgPrefix is required for a 'replacement' resolution");
    const originalOrder = await getOrderById(pool, ticket.order_id);
    if (!originalOrder) throw new Error("Original order not found");
    const { rows: customerRows } = await pool.query<{ display_name: string; phone: string | null; email: string | null }>(
      "SELECT display_name, phone, email FROM identities WHERE id = $1", [ticket.customer_identity_id]
    );
    // CMP-006: a genuinely NEW order — the original's own row is never
    // touched by any of this. idempotencyKey is fresh every time
    // deliberately (a replacement is never itself idempotently
    // retried the way an external import is).
    const { order } = await createOrder(pool, {
      organizationId: ticket.organization_id, idempotencyKey: `replacement-${ticket.id}-${randomUUID()}`, orgPrefix: params.orgPrefix,
      productName: `${originalOrder.product_name} (Replacement for ${originalOrder.display_order_number})`,
      orderValue: 0, shippingAddress: originalOrder.shipping_address ?? undefined,
      customerName: customerRows[0]!.display_name, customerPhone: customerRows[0]!.phone ?? undefined, customerEmail: customerRows[0]!.email ?? undefined,
      createdBy: params.resolvedBy, artworkIntent: "blank",
    });
    replacementOrderId = order.id;
  }

  const { rows } = await pool.query<ComplaintTicket>(
    `UPDATE complaint_tickets SET status = 'resolved', resolution_type = $1, resolution_notes = $2, resolved_by = $3, resolved_at = now(), replacement_order_id = $4, updated_at = now()
     WHERE id = $5 RETURNING *`,
    [params.resolutionType, params.resolutionNotes ?? null, params.resolvedBy, replacementOrderId, params.ticketId]
  );
  return rows[0]!;
}
