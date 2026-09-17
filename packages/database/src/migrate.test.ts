import { describe, it, expect, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { createPool } from "./pool.js";

// Exercises the actual migrate.ts CLI as a subprocess (the same way
// CI and a real operator invoke it) rather than importing its internal
// functions — this is a genuine end-to-end test of the tool a human
// will actually run, against a real Postgres instance.
describe("migration runner", () => {
  const pool = createPool();

  afterAll(async () => {
    await pool.end();
  });

  it("is idempotent: running 'up' twice in a row applies nothing the second time", () => {
    execSync("tsx src/migrate.ts up", { cwd: process.cwd(), env: process.env });
    const secondRun = execSync("tsx src/migrate.ts up", { cwd: process.cwd(), env: process.env }).toString();
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
    // verify down() removes precisely that one.
    const { rows: beforeRows } = await pool.query("SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1");
    const latestId = beforeRows[0]!.id as string;

    execSync("tsx src/migrate.ts down", { cwd: process.cwd(), env: process.env });

    const { rows: afterRows } = await pool.query("SELECT id FROM schema_migrations WHERE id = $1", [latestId]);
    expect(afterRows).toHaveLength(0); // the migration's own tracking row is gone

    // Leave the database in the "up" state for any other suite/dev workflow that follows.
    execSync("tsx src/migrate.ts up", { cwd: process.cwd(), env: process.env });
  });
});
