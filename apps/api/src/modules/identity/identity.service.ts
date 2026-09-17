import type pg from "pg";
import { hashPassword } from "./password.js";

export interface Identity {
  id: string;
  organization_id: string;
  identity_type: "staff" | "partner" | "customer";
  display_name: string;
  email: string | null;
  phone: string | null;
  password_hash: string | null;
  active: boolean;
}

export class DuplicateIdentityError extends Error {
  constructor() {
    super("An identity with this email or phone already exists in this organization");
    this.name = "DuplicateIdentityError";
  }
}

export async function registerIdentity(
  pool: pg.Pool,
  params: { organizationId: string; identityType: Identity["identity_type"]; displayName: string; email?: string; phone?: string; password?: string }
): Promise<Identity> {
  const passwordHash = params.password ? await hashPassword(params.password) : null;
  try {
    const { rows } = await pool.query<Identity>(
      `INSERT INTO identities (organization_id, identity_type, display_name, email, phone, password_hash)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [params.organizationId, params.identityType, params.displayName, params.email ?? null, params.phone ?? null, passwordHash]
    );
    return rows[0]!;
  } catch (err) {
    // Postgres unique_violation
    if ((err as { code?: string }).code === "23505") throw new DuplicateIdentityError();
    throw err;
  }
}

export async function findIdentityByEmail(pool: pg.Pool, organizationId: string, email: string): Promise<Identity | null> {
  const { rows } = await pool.query<Identity>(
    "SELECT * FROM identities WHERE organization_id = $1 AND email = $2 AND active = true",
    [organizationId, email]
  );
  return rows[0] ?? null;
}

export async function findIdentityById(pool: pg.Pool, id: string): Promise<Identity | null> {
  const { rows } = await pool.query<Identity>("SELECT * FROM identities WHERE id = $1 AND active = true", [id]);
  return rows[0] ?? null;
}
