import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { buildApp } from "./server.js";
import { loadConfig } from "./config/config.js";
import { createLogger } from "./shared/logger.js";

// Deliberately NOT mocking the database — this test proves the
// migration (0001_app_health) and the /ready endpoint actually agree
// with each other against a real Postgres instance, which is the one
// thing a mocked test could never catch a regression in.
describe("health and readiness endpoints", () => {
  const config = loadConfig();
  const pool = new pg.Pool({
    host: config.PGHOST, port: config.PGPORT, user: config.PGUSER,
    password: config.PGPASSWORD, database: config.PGDATABASE,
  });
  const logger = createLogger(config);
  const app = buildApp(config, pool, logger);

  afterAll(async () => {
    await pool.end();
  });

  it("GET /health returns 200 without touching the database", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /ready returns 200 with a real DB round-trip when migrations are applied", async () => {
    const res = await request(app).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
    expect(res.body.database).toBe("connected");
  });

  it("every response carries a correlation id, generated when none is supplied", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-correlation-id"]).toBeTruthy();
  });

  it("an inbound correlation id is echoed back unchanged, not replaced", async () => {
    const res = await request(app).get("/health").set("x-correlation-id", "test-fixed-id-123");
    expect(res.headers["x-correlation-id"]).toBe("test-fixed-id-123");
  });

  it("GET /ready returns 503 when the expected row is missing (simulates a broken/un-migrated database)", async () => {
    await pool.query("DELETE FROM app_health WHERE id = 1");
    const res = await request(app).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not_ready");
    // restore state for any subsequent test run
    await pool.query("INSERT INTO app_health (id, status) VALUES (1, 'ok')");
  });
});
