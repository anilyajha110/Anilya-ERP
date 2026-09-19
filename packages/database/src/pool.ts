import pg from "pg";

const { Pool } = pg;

// Configuration validation: fail fast and loud at startup rather than
// on the first query, per Phase 1's "configuration validation" requirement.
function requireEnv(env: NodeJS.ProcessEnv, name: string, fallback?: string): string {
  const value = env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Accepts an optional env override — used by migrate.test.ts to point
// at its own isolated test database without mutating process.env for
// the whole process. Defaults to process.env for every normal caller.
export function createPool(env: NodeJS.ProcessEnv = process.env): pg.Pool {
  return new Pool({
    host: requireEnv(env, "PGHOST", "localhost"),
    port: Number(requireEnv(env, "PGPORT", "5432")),
    user: requireEnv(env, "PGUSER", "postgres"),
    password: env.PGPASSWORD ?? "",
    database: requireEnv(env, "PGDATABASE", "anilya_erp"),
    max: Number(env.PGPOOL_MAX ?? "10"),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}
