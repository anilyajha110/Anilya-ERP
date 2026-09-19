import { randomInt, createHash } from "node:crypto";
import type pg from "pg";

// The service layer Phase 2 deliberately left unbuilt (the
// otp_requests/otp_channel_deliveries tables existed from migration
// 0006, but nothing called them yet — noted honestly in that phase's
// own README section rather than left as a silent gap). Genuinely
// reusable for ANY purpose (invoice download here; a future
// Customer/Partner OTP login would use this exact same service) —
// `purpose` distinguishes them, never a parallel OTP mechanism.
export interface OtpRequest {
  id: string;
  identity_id: string;
  purpose: string;
  expires_at: Date;
  attempts: number;
  max_attempts: number;
  verified_at: Date | null;
}

export class OtpExpiredError extends Error {
  constructor() { super("This OTP has expired"); this.name = "OtpExpiredError"; }
}
export class OtpAttemptsExceededError extends Error {
  constructor() { super("Too many incorrect attempts for this OTP"); this.name = "OtpAttemptsExceededError"; }
}
export class OtpIncorrectError extends Error {
  constructor(public readonly attemptsRemaining: number) { super(`Incorrect OTP — ${attemptsRemaining} attempt(s) remaining`); this.name = "OtpIncorrectError"; }
}
export class OtpAlreadyVerifiedError extends Error {
  constructor() { super("This OTP has already been used"); this.name = "OtpAlreadyVerifiedError"; }
}

function hashOtp(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}
function maskContact(value: string): string {
  return value.length >= 3 ? "*".repeat(Math.max(0, value.length - 3)) + value.slice(-3) : "***";
}

const OTP_TTL_MINUTES = 5;

// The code itself is NEVER persisted — only its hash, exactly like a
// password (the same principle applied consistently since Phase 2's
// very first commit). Returns rawCode ONLY because no real SMS/
// WhatsApp/Email gateway is connected yet — a real integration removes
// this return value entirely, the same documented pattern used
// throughout this project (Phase 1's demoOtp, etc.).
export async function createOtpRequest(
  pool: pg.Pool,
  params: { identityId: string; purpose: string; channels: { channel: "sms" | "whatsapp" | "email"; destination: string }[] }
): Promise<{ otpRequestId: string; rawCode: string; expiresAt: Date }> {
  const code = String(randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  const { rows } = await pool.query<OtpRequest>(
    "INSERT INTO otp_requests (identity_id, purpose, otp_hash, expires_at) VALUES ($1, $2, $3, $4) RETURNING *",
    [params.identityId, params.purpose, hashOtp(code), expiresAt]
  );
  const otpRequestId = rows[0]!.id;

  for (const { channel, destination } of params.channels) {
    await pool.query(
      "INSERT INTO otp_channel_deliveries (otp_request_id, channel, destination_masked, status) VALUES ($1, $2, $3, 'sent')",
      [otpRequestId, channel, maskContact(destination)]
    );
  }
  return { otpRequestId, rawCode: code, expiresAt };
}

// Row-locked so two concurrent verify attempts against the same OTP
// can't both slip through the attempts-remaining check at once.
export async function verifyOtpRequest(pool: pg.Pool, otpRequestId: string, code: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<OtpRequest & { otp_hash: string }>("SELECT * FROM otp_requests WHERE id = $1 FOR UPDATE", [otpRequestId]);
    if (!rows[0]) throw new Error("OTP request not found");
    const otp = rows[0];

    if (otp.verified_at) throw new OtpAlreadyVerifiedError();
    if (new Date() > new Date(otp.expires_at)) throw new OtpExpiredError();
    if (otp.attempts >= otp.max_attempts) throw new OtpAttemptsExceededError();

    if (hashOtp(code) !== otp.otp_hash) {
      await client.query("UPDATE otp_requests SET attempts = attempts + 1 WHERE id = $1", [otpRequestId]);
      await client.query("COMMIT");
      throw new OtpIncorrectError(otp.max_attempts - otp.attempts - 1);
    }

    await client.query("UPDATE otp_requests SET verified_at = now() WHERE id = $1", [otpRequestId]);
    await client.query("COMMIT");
  } catch (err) {
    if (!(err instanceof OtpIncorrectError)) await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
