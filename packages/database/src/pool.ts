import pg from "pg";

const { Pool } = pg;

// Configuration validation: fail fast and loud at startup rather than
// on the first query, per Phase 1's "configuration validation" requirement.
function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function createPool(): pg.Pool {
  return new Pool({
    host: requireEnv("PGHOST", "localhost"),
    port: Number(requireEnv("PGPORT", "5432")),
    user: requireEnv("PGUSER", "postgres"),
    password: process.env.PGPASSWORD ?? "",
    database: requireEnv("PGDATABASE", "anilya_erp"),
    max: Number(process.env.PGPOOL_MAX ?? "10"),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}
