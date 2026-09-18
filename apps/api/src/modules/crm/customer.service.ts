import type pg from "pg";

export interface CustomerRecord {
  identity_id: string;
  display_name: string;
  phone: string | null;
  email: string | null;
  status: "dummy" | "active" | "blocked";
}

// CRM-001: phone -> email -> dummy resolution, ONE customer identity
// per real person within an organization. Phone is checked first
// (the most reliable real-world identifier for repeat customers who
// may use different emails), then email, and only creates a genuinely
// new ("dummy" — incomplete profile) customer if neither matches.
export async function findOrCreateCustomer(
  pool: pg.Pool,
  params: { organizationId: string; displayName: string; phone?: string; email?: string }
): Promise<{ customer: CustomerRecord; wasNew: boolean }> {
  if (params.phone) {
    const { rows } = await pool.query<CustomerRecord>(
      `SELECT i.id AS identity_id, i.display_name, i.phone, i.email, cp.status
       FROM identities i JOIN customer_profiles cp ON cp.identity_id = i.id
       WHERE i.organization_id = $1 AND i.identity_type = 'customer' AND i.phone = $2`,
      [params.organizationId, params.phone]
    );
    if (rows[0]) return { customer: rows[0], wasNew: false };
  }

  if (params.email) {
    const { rows } = await pool.query<CustomerRecord>(
      `SELECT i.id AS identity_id, i.display_name, i.phone, i.email, cp.status
       FROM identities i JOIN customer_profiles cp ON cp.identity_id = i.id
       WHERE i.organization_id = $1 AND i.identity_type = 'customer' AND i.email = $2`,
      [params.organizationId, params.email]
    );
    if (rows[0]) return { customer: rows[0], wasNew: false };
  }

  // Neither phone nor email matched an existing customer — create a
  // new one. No contact info at all means it stays a placeholder
  // ("dummy") record until enriched; having at least one contact
  // method is enough to mark it "active".
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: identityRows } = await client.query(
      `INSERT INTO identities (organization_id, identity_type, display_name, phone, email)
       VALUES ($1, 'customer', $2, $3, $4) RETURNING id, display_name, phone, email`,
      [params.organizationId, params.displayName, params.phone ?? null, params.email ?? null]
    );
    const identity = identityRows[0];
    const status = params.phone || params.email ? "active" : "dummy";
    await client.query("INSERT INTO customer_profiles (identity_id, status) VALUES ($1, $2)", [identity.id, status]);
    await client.query("COMMIT");
    return { customer: { identity_id: identity.id, display_name: identity.display_name, phone: identity.phone, email: identity.email, status }, wasNew: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Ensures a customer-type identity always has a matching profile row,
// regardless of which path created the identity (self-registration via
// the generic Identity module, or the staff-facing findOrCreateCustomer
// above). Idempotent — safe to call even if a row already exists.
export async function ensureCustomerProfile(pool: pg.Pool, identityId: string): Promise<void> {
  await pool.query(
    "INSERT INTO customer_profiles (identity_id, status) VALUES ($1, 'active') ON CONFLICT (identity_id) DO NOTHING",
    [identityId]
  );
}

export async function getCustomerById(pool: pg.Pool, identityId: string): Promise<(CustomerRecord & { billing: Record<string, unknown> }) | null> {
  const { rows } = await pool.query(
    `SELECT i.id AS identity_id, i.display_name, i.phone, i.email, cp.status,
            cp.billing_name, cp.gstin, cp.billing_address, cp.billing_city, cp.billing_district, cp.billing_state, cp.billing_pincode,
            cp.credit_limit, cp.payment_terms
     FROM identities i JOIN customer_profiles cp ON cp.identity_id = i.id
     WHERE i.id = $1 AND i.identity_type = 'customer'`,
    [identityId]
  );
  if (!rows[0]) return null;
  const { identity_id, display_name, phone, email, status, ...billing } = rows[0];
  return { identity_id, display_name, phone, email, status, billing };
}

// CRM-002: structured billing profile. Only overwrites a field if a
// value was actually supplied — never blanks out something already on
// file just because a particular update omitted it.
export async function updateBillingProfile(
  pool: pg.Pool,
  identityId: string,
  fields: Partial<{ billingName: string; gstin: string; billingAddress: string; billingCity: string; billingDistrict: string; billingState: string; billingPincode: string }>
): Promise<void> {
  const columnMap: Record<string, string> = {
    billingName: "billing_name", gstin: "gstin", billingAddress: "billing_address",
    billingCity: "billing_city", billingDistrict: "billing_district", billingState: "billing_state", billingPincode: "billing_pincode",
  };
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    values.push(value);
    sets.push(`${columnMap[key]} = $${values.length}`);
  }
  if (sets.length === 0) return;
  values.push(identityId);
  await pool.query(`UPDATE customer_profiles SET ${sets.join(", ")}, updated_at = now() WHERE identity_id = $${values.length}`, values);
}
