import type pg from "pg";

export interface Product {
  id: string;
  organization_id: string;
  sku: string;
  name: string;
}

export async function createProduct(pool: pg.Pool, params: { organizationId: string; sku: string; name: string }): Promise<Product> {
  const { rows } = await pool.query<Product>(
    "INSERT INTO inventory_products (organization_id, sku, name) VALUES ($1, $2, $3) RETURNING *",
    [params.organizationId, params.sku, params.name]
  );
  return rows[0]!;
}

export async function getProductById(pool: pg.Pool, id: string): Promise<Product | null> {
  const { rows } = await pool.query<Product>("SELECT * FROM inventory_products WHERE id = $1", [id]);
  return rows[0] ?? null;
}

// INV-001: maps an external system's own id for a product to our
// internal one, scoped by (organization, source) — the same external
// id from two different sources never collides, and mapping the same
// external id twice (a replay) is a safe no-op, not a duplicate row.
export async function mapExternalId(pool: pg.Pool, params: { organizationId: string; productId: string; source: string; externalId: string }): Promise<void> {
  await pool.query(
    `INSERT INTO inventory_product_external_map (organization_id, product_id, source, external_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, source, external_id) DO NOTHING`,
    [params.organizationId, params.productId, params.source, params.externalId]
  );
}

export async function resolveByExternalId(pool: pg.Pool, organizationId: string, source: string, externalId: string): Promise<Product | null> {
  const { rows } = await pool.query<Product>(
    `SELECT p.* FROM inventory_products p
     JOIN inventory_product_external_map m ON m.product_id = p.id
     WHERE m.organization_id = $1 AND m.source = $2 AND m.external_id = $3`,
    [organizationId, source, externalId]
  );
  return rows[0] ?? null;
}

// Find-or-create by external id — the common real-world entry point:
// an inbound event names a product only by the SOURCE system's own id,
// and either it's already mapped, or this is the first time we've seen
// it and a new internal product + mapping is created together.
export async function findOrCreateByExternalId(
  pool: pg.Pool,
  params: { organizationId: string; source: string; externalId: string; sku: string; name: string }
): Promise<{ product: Product; wasNew: boolean }> {
  const existing = await resolveByExternalId(pool, params.organizationId, params.source, params.externalId);
  if (existing) return { product: existing, wasNew: false };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<Product>(
      `INSERT INTO inventory_products (organization_id, sku, name) VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, sku) DO UPDATE SET name = EXCLUDED.name RETURNING *`,
      [params.organizationId, params.sku, params.name]
    );
    await client.query(
      `INSERT INTO inventory_product_external_map (organization_id, product_id, source, external_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, source, external_id) DO NOTHING`,
      [params.organizationId, rows[0]!.id, params.source, params.externalId]
    );
    await client.query("COMMIT");
    return { product: rows[0]!, wasNew: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
