import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import pg from "pg";
import { createPool } from "./pool.js";

// Exercises the actual migrate.ts CLI as a subprocess (the same way
// CI and a real operator invoke it) rather than importing its internal
// functions — this is a genuine end-to-end test of the tool a human
// will actually run, against a real Postgres instance.
//
// Runs against its OWN dedicated database, never the shared one
// apps/api's tests use. Found live, running the full verify pipeline
// together rather than each workspace in isolation: migration 0017
// tightens orders_stage_check to allow 'delivered', and its down-script
// correctly refuses to re-tighten that constraint once real 'delivered'
// rows exist (Postgres validates existing data against a re-added
// CHECK) — which is genuinely correct database behavior, but meant this
// schema-mechanism test was silently depending on test EXECUTION ORDER
// across two different workspaces to avoid colliding with the other
// workspace's application data. That's not a real guarantee, so it's
// fixed here at the root: a schema-only test gets a schema-only database.
const TEST_DB_NAME = `${process.env.PGDATABASE ?? "anilya_erp"}_migrate_test`;

describe("migration runner", () => {
  let pool: pg.Pool;
  const testEnv = { ...process.env, PGDATABASE: TEST_DB_NAME };

  beforeAll(async () => {
    const adminPool = new pg.Pool({
      host: process.env.PGHOST, port: Number(process.env.PGPORT ?? 5432),
      user: process.env.PGUSER, password: process.env.PGPASSWORD, database: "postgres",
    });
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
    await adminPool.query(`CREATE DATABASE ${TEST_DB_NAME}`);
    await adminPool.end();
    pool = createPool(testEnv);
  });

  afterAll(async () => {
    await pool.end();
    const adminPool = new pg.Pool({
      host: process.env.PGHOST, port: Number(process.env.PGPORT ?? 5432),
      user: process.env.PGUSER, password: process.env.PGPASSWORD, database: "postgres",
    });
    await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
    await adminPool.end();
  });

  it("is idempotent: running 'up' twice in a row applies nothing the second time", () => {
    execSync("tsx src/migrate.ts up", { cwd: process.cwd(), env: testEnv });
    const secondRun = execSync("tsx src/migrate.ts up", { cwd: process.cwd(), env: testEnv }).toString();
    expect(secondRun).toContain("Already up to date");
  });

  it("app_health table exists and matches schema_migrations after 'up'", async () => {
    const { rows } = await pool.query("SELECT status FROM app_health WHERE id = 1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("ok");

    const { rows: migrationRows } = await pool.query("SELECT id FROM schema_migrations WHERE id = '0001_app_health'");
    expect(migrationRows).toHaveLength(1);
  });

  it("'down' reverses whichever migration is currently the most recent, and updates schema_migrations to match", async () => {
    // Deliberately does NOT hardcode which migration this is — that
    // assumption (originally "it's always app_health") was exactly
    // what broke here once Phase 2 added migrations after it. Ask the
    // database what the latest applied migration actually is, then
    // verify down() removes precisely that one. Safe now against an
    // isolated, empty-of-application-data database — this migration's
    // own down-script no longer has to contend with real 'delivered'
    // orders it knows nothing about.
    const { rows: beforeRows } = await pool.query("SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1");
    const latestId = beforeRows[0]!.id as string;

    execSync("tsx src/migrate.ts down", { cwd: process.cwd(), env: testEnv });

    const { rows: afterRows } = await pool.query("SELECT id FROM schema_migrations WHERE id = $1", [latestId]);
    expect(afterRows).toHaveLength(0); // the migration's own tracking row is gone

    // Leave the test database in the "up" state, tidiness only — it's
    // dropped entirely in afterAll regardless.
    execSync("tsx src/migrate.ts up", { cwd: process.cwd(), env: testEnv });
  });
});

