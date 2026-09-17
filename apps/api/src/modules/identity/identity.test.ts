import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../server.js";
import { loadConfig } from "../../config/config.js";
import { createLogger } from "../../shared/logger.js";

describe("Identity module — registration, login, sessions, RBAC", () => {
  const config = loadConfig();
  const pool = new pg.Pool({
    host: config.PGHOST, port: config.PGPORT, user: config.PGUSER,
    password: config.PGPASSWORD, database: config.PGDATABASE,
  });
  const app = buildApp(config, pool, createLogger(config));

  let orgId: string;
  const email = `test-${randomUUID()}@example.com`;
  const password = "correct-horse-battery-staple";

  beforeAll(async () => {
    const { rows } = await pool.query(
      "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
      [`Test Org ${randomUUID()}`, `test-org-${randomUUID()}`]
    );
    orgId = rows[0].id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("registers a new identity", async () => {
    const res = await request(app).post("/api/identities/register").send({
      organizationId: orgId, identityType: "staff", displayName: "Test Manager", email, password,
    });
    expect(res.status).toBe(201);
    expect(res.body.displayName).toBe("Test Manager");
  });

  it("rejects a duplicate registration in the same organization (409)", async () => {
    const res = await request(app).post("/api/identities/register").send({
      organizationId: orgId, identityType: "staff", displayName: "Duplicate Attempt", email, password,
    });
    expect(res.status).toBe(409);
  });

  it("allows the SAME email in a DIFFERENT organization (multi-tenant isolation)", async () => {
    const { rows } = await pool.query(
      "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
      [`Other Org ${randomUUID()}`, `other-org-${randomUUID()}`]
    );
    const res = await request(app).post("/api/identities/register").send({
      organizationId: rows[0].id, identityType: "staff", displayName: "Same Email Different Org", email, password,
    });
    expect(res.status).toBe(201);
  });

  it("rejects login with the wrong password (401), no hint about which part was wrong", async () => {
    const res = await request(app).post("/api/identities/login").send({ organizationId: orgId, email, password: "wrong-password" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_credentials");
  });

  it("logs in with correct credentials and returns a session token", async () => {
    const res = await request(app).post("/api/identities/login").send({ organizationId: orgId, email, password });
    expect(res.status).toBe(200);
    expect(res.body.sessionToken).toBeTruthy();
    expect(res.body.identity.displayName).toBe("Test Manager");
  });

  it("GET /me with a valid session token returns the correct identity", async () => {
    const login = await request(app).post("/api/identities/login").send({ organizationId: orgId, email, password });
    const token = login.body.sessionToken;

    const me = await request(app).get("/api/identities/me").set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.displayName).toBe("Test Manager");
  });

  it("GET /me with no token is rejected (401)", async () => {
    const res = await request(app).get("/api/identities/me");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_bearer_token");
  });

  it("GET /me with a garbage token is rejected (401), not crashed", async () => {
    const res = await request(app).get("/api/identities/me").set("Authorization", "Bearer this-is-not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("CRITICAL — a client-supplied role claim in the body is completely ignored; only a verified session counts (fixes Phase 0's RISK-003)", async () => {
    // The exact pattern the prototype was vulnerable to: claiming a
    // privileged role directly in the request body, with no real session.
    const res = await request(app).get("/api/identities/me").send({ actorRole: "Super Admin", identityId: "anything" });
    expect(res.status).toBe(401); // proves the body is never consulted for identity — only the Bearer session is
  });

  it("logout revokes the session — the same token stops working immediately after", async () => {
    const login = await request(app).post("/api/identities/login").send({ organizationId: orgId, email, password });
    const token = login.body.sessionToken;

    const logout = await request(app).post("/api/identities/logout").set("Authorization", `Bearer ${token}`);
    expect(logout.status).toBe(200);

    const meAfter = await request(app).get("/api/identities/me").set("Authorization", `Bearer ${token}`);
    expect(meAfter.status).toBe(401);
  });

  it("every login is captured in the immutable audit_log in real time", async () => {
    const beforeCount = (await pool.query("SELECT COUNT(*) FROM audit_log WHERE organization_id = $1 AND action_type = 'identity.login'", [orgId])).rows[0].count;
    await request(app).post("/api/identities/login").send({ organizationId: orgId, email, password });
    const afterCount = (await pool.query("SELECT COUNT(*) FROM audit_log WHERE organization_id = $1 AND action_type = 'identity.login'", [orgId])).rows[0].count;
    expect(Number(afterCount)).toBe(Number(beforeCount) + 1);

    const { rows } = await pool.query(
      "SELECT * FROM audit_log WHERE organization_id = $1 AND action_type = 'identity.login' ORDER BY created_at DESC LIMIT 1",
      [orgId]
    );
    expect(rows[0].actor_identity_id).toBeTruthy();
    expect(rows[0].session_id).toBeTruthy();
    expect(rows[0].remarks).toContain("Test Manager");
  });
});

describe("RBAC — permission enforcement is derived from the database, never the client", () => {
  const config = loadConfig();
  const pool = new pg.Pool({
    host: config.PGHOST, port: config.PGPORT, user: config.PGUSER,
    password: config.PGPASSWORD, database: config.PGDATABASE,
  });
  const app = buildApp(config, pool, createLogger(config));

  let orgId: string;
  let privilegedToken: string;
  let unprivilegedToken: string;

  beforeAll(async () => {
    const { rows: orgRows } = await pool.query(
      "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
      [`RBAC Test Org ${randomUUID()}`, `rbac-test-${randomUUID()}`]
    );
    orgId = orgRows[0].id;

    // A real permission, a real role that grants it, and one identity
    // WITH the role, one WITHOUT — exactly the setup needed to prove
    // requirePermission() checks the database, not a claim.
    const { rows: permRows } = await pool.query(
      "INSERT INTO permissions (key, description) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description RETURNING id",
      ["test.privileged_action", "A permission only some roles should have"]
    );
    const { rows: roleRows } = await pool.query(
      "INSERT INTO roles (organization_id, name) VALUES ($1, $2) RETURNING id",
      [orgId, "Privileged Role"]
    );
    await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)", [roleRows[0].id, permRows[0].id]);

    const privilegedEmail = `privileged-${randomUUID()}@example.com`;
    const unprivilegedEmail = `unprivileged-${randomUUID()}@example.com`;
    const pw = "test-password-123";

    const privileged = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "Privileged User", email: privilegedEmail, password: pw });
    await pool.query("INSERT INTO identity_roles (identity_id, role_id) VALUES ($1, $2)", [privileged.body.id, roleRows[0].id]);
    await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "Unprivileged User", email: unprivilegedEmail, password: pw });

    privilegedToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: privilegedEmail, password: pw })).body.sessionToken;
    unprivilegedToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: unprivilegedEmail, password: pw })).body.sessionToken;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("an identity WITHOUT the required permission is rejected (403) from a permission-gated route", async () => {
    // Build a tiny throwaway gated route inline to prove the middleware itself.
    const { requirePermission, requireAuth } = await import("../../modules/identity/rbac.js");
    app.get("/api/__test/privileged", requireAuth(pool), requirePermission(pool, "test.privileged_action"), (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/api/__test/privileged").set("Authorization", `Bearer ${unprivilegedToken}`);
    expect(res.status).toBe(403);
    expect(res.body.requiredPermission).toBe("test.privileged_action");
  });

  it("an identity WITH the required permission succeeds (200) on the same route", async () => {
    const res = await request(app).get("/api/__test/privileged").set("Authorization", `Bearer ${privilegedToken}`);
    expect(res.status).toBe(200);
  });
});
