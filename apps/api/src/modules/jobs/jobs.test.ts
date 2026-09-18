import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../server.js";
import { loadConfig } from "../../config/config.js";
import { createLogger } from "../../shared/logger.js";

describe("Jobs — lifecycle, JOB-004 (partner login gate), JOB-002 (qc-pass gate), escalation", () => {
  const config = loadConfig();
  const pool = new pg.Pool({
    host: config.PGHOST, port: config.PGPORT, user: config.PGUSER,
    password: config.PGPASSWORD, database: config.PGDATABASE,
  });
  const app = buildApp(config, pool, createLogger(config));

  let orgId: string;
  let staffToken: string;
  let managerToken: string; // additionally has jobs.escalations.manage
  let loggedInPartnerId: string;
  let neverLoggedInPartnerId: string;

  beforeAll(async () => {
    const { rows } = await pool.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [`Jobs Test ${randomUUID()}`, `jobs-test-${randomUUID()}`]);
    orgId = rows[0].id;

    for (const key of ["orders.import", "orders.read", "orders.write", "jobs.manage", "jobs.escalations.manage"]) {
      await pool.query("INSERT INTO permissions (key, description) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [key, key]);
    }
    const { rows: staffRole } = await pool.query("INSERT INTO roles (organization_id, name) VALUES ($1, 'Jobs Staff') RETURNING id", [orgId]);
    for (const key of ["orders.import", "orders.read", "orders.write", "jobs.manage"]) {
      await pool.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = $2", [staffRole[0].id, key]);
    }
    const { rows: mgrRole } = await pool.query("INSERT INTO roles (organization_id, name) VALUES ($1, 'Jobs Manager') RETURNING id", [orgId]);
    for (const key of ["orders.import", "orders.read", "orders.write", "jobs.manage", "jobs.escalations.manage"]) {
      await pool.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = $2", [mgrRole[0].id, key]);
    }

    const staffEmail = `jobs-staff-${randomUUID()}@example.com`;
    const staff = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "Jobs Staff", email: staffEmail, password: "pw123456" });
    await pool.query("INSERT INTO identity_roles (identity_id, role_id) VALUES ($1, $2)", [staff.body.id, staffRole[0].id]);
    staffToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: staffEmail, password: "pw123456" })).body.sessionToken;

    const mgrEmail = `jobs-mgr-${randomUUID()}@example.com`;
    const mgr = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "Jobs Manager", email: mgrEmail, password: "pw123456" });
    await pool.query("INSERT INTO identity_roles (identity_id, role_id) VALUES ($1, $2)", [mgr.body.id, mgrRole[0].id]);
    managerToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: mgrEmail, password: "pw123456" })).body.sessionToken;

    // A Partner who genuinely logs in at least once...
    const loggedInEmail = `partner-loggedin-${randomUUID()}@example.com`;
    const loggedInPartner = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "partner", displayName: "Logged-In Partner", email: loggedInEmail, password: "pw123456" });
    loggedInPartnerId = loggedInPartner.body.id;
    await request(app).post("/api/identities/login").send({ organizationId: orgId, email: loggedInEmail, password: "pw123456" }); // this login is the entire point — creates a real sessions row

    // ...and a Partner who is registered but has NEVER logged in.
    const neverLoggedInEmail = `partner-never-${randomUUID()}@example.com`;
    const neverLoggedInPartner = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "partner", displayName: "Never Logged In Partner", email: neverLoggedInEmail, password: "pw123456" });
    neverLoggedInPartnerId = neverLoggedInPartner.body.id;
  });

  afterAll(async () => { await pool.end(); });

  async function importOrder() {
    const res = await request(app).post("/api/orders/import").set("Authorization", `Bearer ${staffToken}`).send({
      idempotencyKey: randomUUID(), orgPrefix: "ANILYA", productName: "Jobs Test Product", customerName: `Jobs Customer ${randomUUID()}`, artworkIntent: "blank",
    });
    return res.body;
  }

  it("CRITICAL (JOB-004) — a Partner who has NEVER logged in cannot receive a direct job assignment (409)", async () => {
    const order = await importOrder();
    const job = await request(app).post(`/api/orders/${order.id}/jobs`).set("Authorization", `Bearer ${staffToken}`).send({ jobType: "fixed", description: "Print 500 cards" });

    const res = await request(app).post(`/api/jobs/${job.body.id}/assign`).set("Authorization", `Bearer ${staffToken}`).send({ partnerIdentityId: neverLoggedInPartnerId });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/never logged in/);
  });

  it("CRITICAL (JOB-004, inverse) — a Partner who HAS logged in at least once can be assigned", async () => {
    const order = await importOrder();
    const job = await request(app).post(`/api/orders/${order.id}/jobs`).set("Authorization", `Bearer ${staffToken}`).send({ jobType: "fixed", description: "Print 500 cards" });

    const res = await request(app).post(`/api/jobs/${job.body.id}/assign`).set("Authorization", `Bearer ${staffToken}`).send({ partnerIdentityId: loggedInPartnerId });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("assigned");
  });

  it("full job lifecycle: open -> assigned -> in_progress -> completed", async () => {
    const order = await importOrder();
    const job = await request(app).post(`/api/orders/${order.id}/jobs`).set("Authorization", `Bearer ${staffToken}`).send({ jobType: "fixed", description: "Lamination" });
    expect(job.body.status).toBe("open");

    await request(app).post(`/api/jobs/${job.body.id}/assign`).set("Authorization", `Bearer ${staffToken}`).send({ partnerIdentityId: loggedInPartnerId });
    const started = await request(app).post(`/api/jobs/${job.body.id}/start`).set("Authorization", `Bearer ${staffToken}`).send({});
    expect(started.body.status).toBe("in_progress");
    const completed = await request(app).post(`/api/jobs/${job.body.id}/complete`).set("Authorization", `Bearer ${staffToken}`).send({});
    expect(completed.body.status).toBe("completed");
  });

  it("starting a job that was never assigned is rejected (409)", async () => {
    const order = await importOrder();
    const job = await request(app).post(`/api/orders/${order.id}/jobs`).set("Authorization", `Bearer ${staffToken}`).send({ jobType: "extra", description: "Never assigned" });
    const res = await request(app).post(`/api/jobs/${job.body.id}/start`).set("Authorization", `Bearer ${staffToken}`).send({});
    expect(res.status).toBe(409);
  });

  it("CRITICAL (JOB-002) — an order with any incomplete job cannot complete, and the error names exactly which job is blocking", async () => {
    const order = await importOrder();
    await request(app).post(`/api/orders/${order.id}/confirm`).set("Authorization", `Bearer ${staffToken}`).send({});
    await request(app).post(`/api/orders/${order.id}/start`).set("Authorization", `Bearer ${staffToken}`).send({});
    await request(app).post(`/api/orders/${order.id}/jobs`).set("Authorization", `Bearer ${staffToken}`).send({ jobType: "fixed", description: "Cutting" });
    // Deliberately left in 'open' — never assigned, started, or completed.

    const res = await request(app).post(`/api/orders/${order.id}/complete`).set("Authorization", `Bearer ${staffToken}`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Cutting");
  });

  it("CRITICAL (JOB-002, inverse) — once every job is completed, the order can complete", async () => {
    const order = await importOrder();
    await request(app).post(`/api/orders/${order.id}/confirm`).set("Authorization", `Bearer ${staffToken}`).send({});
    await request(app).post(`/api/orders/${order.id}/start`).set("Authorization", `Bearer ${staffToken}`).send({});
    const job = await request(app).post(`/api/orders/${order.id}/jobs`).set("Authorization", `Bearer ${staffToken}`).send({ jobType: "fixed", description: "Binding" });
    await request(app).post(`/api/jobs/${job.body.id}/assign`).set("Authorization", `Bearer ${staffToken}`).send({ partnerIdentityId: loggedInPartnerId });
    await request(app).post(`/api/jobs/${job.body.id}/start`).set("Authorization", `Bearer ${staffToken}`).send({});
    await request(app).post(`/api/jobs/${job.body.id}/complete`).set("Authorization", `Bearer ${staffToken}`).send({});

    const res = await request(app).post(`/api/orders/${order.id}/complete`).set("Authorization", `Bearer ${staffToken}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe("completed");
  });

  it("an order with NO jobs at all completes freely — JOB-002 only blocks on jobs that actually exist", async () => {
    const order = await importOrder();
    await request(app).post(`/api/orders/${order.id}/confirm`).set("Authorization", `Bearer ${staffToken}`).send({});
    await request(app).post(`/api/orders/${order.id}/start`).set("Authorization", `Bearer ${staffToken}`).send({});
    const res = await request(app).post(`/api/orders/${order.id}/complete`).set("Authorization", `Bearer ${staffToken}`).send({});
    expect(res.status).toBe(200);
  });

  it("escalating a job with an invalid reason is rejected (400)", async () => {
    const order = await importOrder();
    const job = await request(app).post(`/api/orders/${order.id}/jobs`).set("Authorization", `Bearer ${staffToken}`).send({ jobType: "fixed", description: "X" });
    const res = await request(app).post(`/api/jobs/${job.body.id}/escalate`).set("Authorization", `Bearer ${staffToken}`).send({ triggerReason: "not_a_real_reason" });
    expect(res.status).toBe(400);
  });

  it("a job cannot be escalated twice while the first escalation is still open (409)", async () => {
    const order = await importOrder();
    const job = await request(app).post(`/api/orders/${order.id}/jobs`).set("Authorization", `Bearer ${staffToken}`).send({ jobType: "fixed", description: "Y" });
    await request(app).post(`/api/jobs/${job.body.id}/escalate`).set("Authorization", `Bearer ${staffToken}`).send({ triggerReason: "never_assigned" });
    const res = await request(app).post(`/api/jobs/${job.body.id}/escalate`).set("Authorization", `Bearer ${staffToken}`).send({ triggerReason: "emergency" });
    expect(res.status).toBe(409);
  });

  it("resolving an escalation clears it, and it no longer appears in the open queue", async () => {
    const order = await importOrder();
    const job = await request(app).post(`/api/orders/${order.id}/jobs`).set("Authorization", `Bearer ${staffToken}`).send({ jobType: "fixed", description: "Z" });
    await request(app).post(`/api/jobs/${job.body.id}/escalate`).set("Authorization", `Bearer ${staffToken}`).send({ triggerReason: "timeout" });

    const resolve = await request(app).post(`/api/jobs/${job.body.id}/escalate/resolve`).set("Authorization", `Bearer ${managerToken}`).send({ resolutionNote: "Reassigned manually" });
    expect(resolve.status).toBe(200);

    const queue = await request(app).get("/api/escalations").set("Authorization", `Bearer ${managerToken}`);
    expect(queue.body.find((e: { job_id: string }) => e.job_id === job.body.id)).toBeUndefined();
  });

  it("CRITICAL RBAC — ordinary staff (jobs.manage but NOT jobs.escalations.manage) cannot resolve an escalation (403)", async () => {
    const order = await importOrder();
    const job = await request(app).post(`/api/orders/${order.id}/jobs`).set("Authorization", `Bearer ${staffToken}`).send({ jobType: "fixed", description: "W" });
    await request(app).post(`/api/jobs/${job.body.id}/escalate`).set("Authorization", `Bearer ${staffToken}`).send({ triggerReason: "rejected" });

    const res = await request(app).post(`/api/jobs/${job.body.id}/escalate/resolve`).set("Authorization", `Bearer ${staffToken}`).send({});
    expect(res.status).toBe(403);
  });
});
