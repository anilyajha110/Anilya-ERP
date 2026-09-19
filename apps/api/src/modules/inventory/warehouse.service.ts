import type pg from "pg";

export interface Warehouse {
  id: string;
  organization_id: string;
  name: string;
  city: string | null;
  is_default: boolean;
}

export class NoDefaultWarehouseError extends Error {
  constructor() { super("No warehouse was specified and this organization has no default warehouse configured — set one explicitly with setDefaultWarehouse() before relying on resolution"); this.name = "NoDefaultWarehouseError"; }
}

export async function createWarehouse(pool: pg.Pool, params: { organizationId: string; name: string; city?: string }): Promise<Warehouse> {
  const { rows } = await pool.query<Warehouse>(
    "INSERT INTO inventory_warehouses (organization_id, name, city) VALUES ($1, $2, $3) RETURNING *",
    [params.organizationId, params.name, params.city ?? null]
  );
  return rows[0]!;
}

// Exactly one default per organization, enforced by the database's own
// partial unique index (migration 0020) — clearing every other
// warehouse's flag first inside the same transaction is what makes
// "set THIS one as default" atomic, not a race between two requests
// each thinking they set it.
export async function setDefaultWarehouse(pool: pg.Pool, organizationId: string, warehouseId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE inventory_warehouses SET is_default = false WHERE organization_id = $1", [organizationId]);
    await client.query("UPDATE inventory_warehouses SET is_default = true WHERE id = $1 AND organization_id = $2", [warehouseId, organizationId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// INV-008 fix: a real, deterministic strategy — never "whichever
// warehouse happens to be first in the table" (the prototype's own
// documented placeholder). An explicit warehouseId always wins; absent
// that, the organization's own explicitly-configured default is used;
// absent THAT, this throws loudly rather than silently guessing.
export async function resolveWarehouse(pool: pg.Pool, organizationId: string, explicitWarehouseId?: string): Promise<Warehouse> {
  if (explicitWarehouseId) {
    const { rows } = await pool.query<Warehouse>("SELECT * FROM inventory_warehouses WHERE id = $1 AND organization_id = $2", [explicitWarehouseId, organizationId]);
    if (!rows[0]) throw new Error("Specified warehouse not found in this organization");
    return rows[0];
  }
  const { rows } = await pool.query<Warehouse>("SELECT * FROM inventory_warehouses WHERE organization_id = $1 AND is_default = true", [organizationId]);
  if (!rows[0]) throw new NoDefaultWarehouseError();
  return rows[0];
}
