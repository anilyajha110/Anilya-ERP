// Deliberately minimal for this phase — Booking/Orders establishes the
// entity and a generic lifecycle; Artwork, Production, Logistics etc.
// (their own later phases, per the blueprint's own module ordering)
// extend this with their own intermediate stages rather than this
// phase trying to anticipate all of them.
//
// 'delivered' added in Phase 9 (0017_invoices) — 'completed' means
// production work is done, which is NOT the same real-world fact as
// the customer having actually received the order. Invoicing (FIN-001)
// is gated on 'delivered' specifically, never 'completed'.
export const ORDER_STAGES = ["imported", "confirmed", "in_progress", "completed", "delivered", "cancelled"] as const;
export type OrderStage = (typeof ORDER_STAGES)[number];

export const ORDER_TRANSITIONS: Record<string, { from: OrderStage[]; to: OrderStage }> = {
  confirm: { from: ["imported"], to: "confirmed" },
  start: { from: ["confirmed"], to: "in_progress" },
  complete: { from: ["in_progress"], to: "completed" },
  deliver: { from: ["completed"], to: "delivered" },
  // Cancellation is reachable from any stage BEFORE completion — never
  // after. A completed (or delivered) order is done; "cancelling" it is
  // a different real-world action (a refund/complaint), not an
  // order-stage transition, and stays out of scope for this table.
  cancel: { from: ["imported", "confirmed", "in_progress"], to: "cancelled" },
};

export class InvalidTransitionError extends Error {
  constructor(action: string, currentStage: string) {
    super(`Cannot '${action}' an order in stage '${currentStage}'`);
    this.name = "InvalidTransitionError";
  }
}

export function assertValidTransition(action: string, currentStage: string): OrderStage {
  const rule = ORDER_TRANSITIONS[action];
  if (!rule) throw new Error(`Unknown order action: ${action}`);
  if (!rule.from.includes(currentStage as OrderStage)) throw new InvalidTransitionError(action, currentStage);
  return rule.to;
}
