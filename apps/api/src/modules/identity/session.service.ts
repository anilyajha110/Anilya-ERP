import { randomBytes, createHash } from "node:crypto";
import type pg from "pg";

export interface Session {
  id: string;
  identity_id: string;
  login_method: "password" | "otp" | "password_otp";
  expires_at: Date;
  revoked_at: Date | null;
}

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

const SESSION_TTL_HOURS = 12;

// Returns the RAW token (given to the client as a Bearer token) — only
// its hash is ever persisted, the same principle already applied to
// OTPs and API keys, applied consistently here from the first commit.
export async function createSession(
  pool: pg.Pool,
  params: { identityId: string; loginMethod: Session["login_method"]; otpRequestId?: string; ipAddress?: string; deviceInfo?: string }
): Promise<{ rawToken: string; session: Session }> {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000);

  const { rows } = await pool.query<Session>(
    `INSERT INTO sessions (identity_id, token_hash, login_method, otp_request_id, ip_address, device_info, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, identity_id, login_method, expires_at, revoked_at`,
    [params.identityId, tokenHash, params.loginMethod, params.otpRequestId ?? null, params.ipAddress ?? null, params.deviceInfo ?? null, expiresAt]
  );
  return { rawToken, session: rows[0]! };
}

// Session-derived authentication is THE fix for RISK-003: the prototype
// trusted a client-supplied `actorRole` string on dozens of endpoints.
// This function is the ONLY source of truth for "who is making this
// request" — nothing in this system may accept an identity/role from
// the request body instead.
export async function verifySession(pool: pg.Pool, rawToken: string): Promise<{ session: Session; identityId: string } | null> {
  const tokenHash = hashToken(rawToken);
  const { rows } = await pool.query<Session & { identity_id: string }>(
    `SELECT id, identity_id, login_method, expires_at, revoked_at FROM sessions
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [tokenHash]
  );
  if (rows.length === 0) return null;
  return { session: rows[0]!, identityId: rows[0]!.identity_id };
}

export async function revokeSession(pool: pg.Pool, rawToken: string): Promise<boolean> {
  const tokenHash = hashToken(rawToken);
  const { rowCount } = await pool.query(
    "UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
    [tokenHash]
  );
  return (rowCount ?? 0) > 0;
}
