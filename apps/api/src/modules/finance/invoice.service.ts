import type pg from "pg";

export interface Invoice {
  id: string;
  organization_id: string;
  order_id: string;
  invoice_number: string;
  amount: string;
  generated_by: string | null;
  generated_at: Date;
}

// FIN-001: an order not actually 'delivered' cannot be invoiced —
// checked here, inside the ONE function that creates an invoice, not
// scattered across routes (the same "hard-blocked at every layer"
// discipline as Phase 5's print-ready gate). 'completed' (production
// finished) is deliberately NOT sufficient — 'delivered' is a genuinely
// different real-world fact the customer's own receipt of the order
// establishes.
export class OrderNotDeliveredError extends Error {
  constructor(actualStage: string) { super(`Cannot generate an invoice — this order is '${actualStage}', not 'delivered'`); this.name = "OrderNotDeliveredError"; }
}
export class InvoiceAlreadyExistsError extends Error {
  constructor() { super("An invoice already exists for this order"); this.name = "InvoiceAlreadyExistsError"; }
}

async function nextInvoiceNumber(client: pg.PoolClient, organizationId: string, orgPrefix: string): Promise<string> {
  const year = new Date().getUTCFullYear();
  await client.query(
    "INSERT INTO invoice_number_counters (organization_id, year, last_number) VALUES ($1, $2, 0) ON CONFLICT (organization_id, year) DO NOTHING",
    [organizationId, year]
  );
  const { rows } = await client.query<{ last_number: number }>(
    "UPDATE invoice_number_counters SET last_number = last_number + 1 WHERE organization_id = $1 AND year = $2 RETURNING last_number",
    [organizationId, year]
  );
  return `${orgPrefix}/INV/${year}/${String(rows[0]!.last_number).padStart(5, "0")}`;
}

export async function generateInvoice(pool: pg.Pool, orderId: string, orgPrefix: string, generatedBy?: string): Promise<Invoice> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: orderRows } = await client.query<{ organization_id: string; stage: string; order_value: string }>(
      "SELECT organization_id, stage, order_value FROM orders WHERE id = $1 FOR UPDATE", [orderId]
    );
    if (!orderRows[0]) throw new Error("Order not found");
    if (orderRows[0].stage !== "delivered") throw new OrderNotDeliveredError(orderRows[0].stage);

    const { rows: existing } = await client.query("SELECT 1 FROM invoices WHERE order_id = $1", [orderId]);
    if (existing[0]) throw new InvoiceAlreadyExistsError();

    const invoiceNumber = await nextInvoiceNumber(client, orderRows[0].organization_id, orgPrefix);
    const { rows } = await client.query<Invoice>(
      "INSERT INTO invoices (organization_id, order_id, invoice_number, amount, generated_by) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [orderRows[0].organization_id, orderId, invoiceNumber, orderRows[0].order_value, generatedBy ?? null]
    );
    await client.query("COMMIT");
    return rows[0]!;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getInvoiceByOrderId(pool: pg.Pool, orderId: string): Promise<Invoice | null> {
  const { rows } = await pool.query<Invoice>("SELECT * FROM invoices WHERE order_id = $1", [orderId]);
  return rows[0] ?? null;
}

export async function getInvoiceById(pool: pg.Pool, id: string): Promise<Invoice | null> {
  const { rows } = await pool.query<Invoice>("SELECT * FROM invoices WHERE id = $1", [id]);
  return rows[0] ?? null;
}
