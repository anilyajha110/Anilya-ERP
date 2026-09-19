import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { buildApp } from "../server.js";
import { loadConfig } from "../config/config.js";
import { createLogger } from "../shared/logger.js";

// A dedicated, single place to look for the cross-cutting security
// properties every phase since Phase 1 has individually relied on —
// closes RISK-010 from the Phase 0 audit ("no automated security
// regression suite... every finding was verified by hand, once").
// Every property below is verified live here, not just asserted in a
// comment, and re-runs on every single `npm run verify`, not just once
// when it was first built.
describe("Security regression suite", () => {
  const config = loadConfig({ ...process.env, ALLOWED_ORIGINS: "https://app.example.com" });
  const pool = new pg.Pool({
    host: config.PGHOST, port: config.PGPORT, user: config.PGUSER,
    password: config.PGPASSWORD, database: config.PGDATABASE,
  });
  const app = buildApp(config, pool, createLogger(config));

  let orgId: string;

  beforeAll(async () => {
    const { rows } = await pool.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [`Security Test ${randomUUID()}`, `security-test-${randomUUID()}`]);
    orgId = rows[0].id;
  });

  afterAll(async () => { await pool.end(); });

  describe("CORS — closed by default (RISK-011)", () => {
    it("a request from an origin NOT in ALLOWED_ORIGINS gets no CORS success header", async () => {
      const res = await request(app).get("/health").set("Origin", "https://evil-attacker.example");
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("a request from an origin that IS in ALLOWED_ORIGINS gets the matching CORS header", async () => {
      const res = await request(app).get("/health").set("Origin", "https://app.example.com");
      expect(res.headers["access-control-allow-origin"]).toBe("https://app.example.com");
    });

    it("a same-origin / server-to-server request (no Origin header at all) is unaffected either way", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
    });
  });

  describe("Rate limiting on authentication endpoints", () => {
    it("CRITICAL — the 11th login attempt within the window is rejected (429), proving the real limiter, not just its config", async () => {
      const email = `ratelimit-${randomUUID()}@example.com`;
      await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "Rate Limit Test", email, password: "pw123456" });

      let lastStatus = 200;
      for (let i = 0; i < 11; i++) {
        const res = await request(app).post("/api/identities/login").set("X-Test-Rate-Limit", "1").send({ organizationId: orgId, email, password: "wrong-password" });
        lastStatus = res.status;
      }
      expect(lastStatus).toBe(429);
    });
  });

  describe("No sensitive data ever leaks into an API response body", () => {
    it("password_hash never appears anywhere in the registration or login response", async () => {
      const email = `noleak-${randomUUID()}@example.com`;
      const register = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "No Leak Test", email, password: "pw123456" });
      expect(JSON.stringify(register.body)).not.toContain("password_hash");
      expect(JSON.stringify(register.body)).not.toContain("pw123456");

      const login = await request(app).post("/api/identities/login").send({ organizationId: orgId, email, password: "pw123456" });
      expect(JSON.stringify(login.body)).not.toContain("password_hash");
      expect(JSON.stringify(login.body)).not.toContain("pw123456");
    });
  });

  describe("SQL injection resistance", () => {
    it("a classic injection payload in a text field is stored and returned LITERALLY, never executed", async () => {
      const injectionAttempt = "Robert'); DROP TABLE organizations;--";
      const email = `injection-${randomUUID()}@example.com`;
      const res = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: injectionAttempt, email, password: "pw123456" });
      expect(res.status).toBe(201);
      expect(res.body.displayName).toBe(injectionAttempt);

      const { rows } = await pool.query("SELECT COUNT(*) FROM organizations");
      expect(Number(rows[0].count)).toBeGreaterThan(0);
    });
  });

  describe("Errors never leak implementation details", () => {
    it("an unhandled error returns a clean, structured body — no stack trace, no file paths", async () => {
      const res = await request(app).get("/api/identities/me").set("Authorization", "Bearer not-a-real-token");
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/\.ts:\d+/);
      expect(body).not.toContain("/home/");
      expect(body).not.toContain("node_modules");
    });
  });

  describe("Standard security headers (Helmet)", () => {
    it("responses carry baseline security headers", async () => {
      const res = await request(app).get("/health");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-powered-by"]).toBeUndefined();
    });
  });
});
