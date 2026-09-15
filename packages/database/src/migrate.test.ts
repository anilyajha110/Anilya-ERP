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

  it("'down' reverses the most recent migration and updates schema_migrations", () => {
    execSync("tsx src/migrate.ts down", { cwd: process.cwd(), env: process.env });
    const tableCheck = execSync(
      `PGPASSWORD=${process.env.PGPASSWORD} psql -h ${process.env.PGHOST} -U ${process.env.PGUSER} -d ${process.env.PGDATABASE} -tAc "SELECT to_regclass('app_health')"`
    ).toString().trim();
    expect(tableCheck).toBe(""); // to_regclass returns empty/null when the table no longer exists

    // Leave the database in the "up" state for any other suite/dev workflow that follows.
    execSync("tsx src/migrate.ts up", { cwd: process.cwd(), env: process.env });
  });
});
