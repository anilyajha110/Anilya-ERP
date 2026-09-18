import type pg from "pg";

// ANILYA/YYYY/MM/##### — generated inside the SAME transaction as the
// order insert (see order.service.ts), row-locking the counter so two
// concurrent imports in the same org/month can never be handed the
// same number. A global Postgres SEQUENCE couldn't do this: numbering
// must restart at 1 for each organization each month, not just count
// up forever.
export async function nextDisplayOrderNumber(client: pg.PoolClient, organizationId: string, orgPrefix: string): Promise<string> {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  await client.query(
    `INSERT INTO order_number_counters (organization_id, year, month, last_number) VALUES ($1, $2, $3, 0)
     ON CONFLICT (organization_id, year, month) DO NOTHING`,
    [organizationId, year, month]
  );
  const { rows } = await client.query<{ last_number: number }>(
    `UPDATE order_number_counters SET last_number = last_number + 1
     WHERE organization_id = $1 AND year = $2 AND month = $3
     RETURNING last_number`,
    [organizationId, year, month]
  );
  const sequence = rows[0]!.last_number;
  return `${orgPrefix}/${year}/${String(month).padStart(2, "0")}/${String(sequence).padStart(5, "0")}`;
}
