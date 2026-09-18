import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../server.js";
import { loadConfig } from "../../config/config.js";
import { createLogger } from "../../shared/logger.js";

describe("Gang Run — pooling only print-ready orders (ART-004/ART-005)", () => {
  const config = loadConfig();
  const pool = new pg.Pool({
    host: config.PGHOST, port: config.PGPORT, user: config.PGUSER,
    password: config.PGPASSWORD, database: config.PGDATABASE,
  });
  const app = buildApp(config, pool, createLogger(config));

  let orgId: string;
  let staffToken: string;
  let supervisorToken: string;

  beforeAll(async () => {
    const { rows } = await pool.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [`Gang Run Test ${randomUUID()}`, `gangrun-test-${randomUUID()}`]);
    orgId = rows[0].id;

    for (const key of ["orders.import", "orders.read", "orders.write", "orders.artwork.approve", "gangrun.manage"]) {
      await pool.query("INSERT INTO permissions (key, description) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [key, key]);
    }
    const { rows: staffRole } = await pool.query("INSERT INTO roles (organization_id, name) VALUES ($1, 'Gang Run Staff') RETURNING id", [orgId]);
    for (const key of ["orders.import", "orders.read", "orders.write"]) {
      await pool.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = $2", [staffRole[0].id, key]);
    }
    const { rows: supRole } = await pool.query("INSERT INTO roles (organization_id, name) VALUES ($1, 'Gang Run Supervisor') RETURNING id", [orgId]);
    for (const key of ["orders.import", "orders.read", "orders.write", "orders.artwork.approve", "gangrun.manage"]) {
      await pool.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = $2", [supRole[0].id, key]);
    }

    const staffEmail = `gangrun-staff-${randomUUID()}@example.com`;
    const staff = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "Gang Run Staff", email: staffEmail, password: "pw123456" });
    await pool.query("INSERT INTO identity_roles (identity_id, role_id) VALUES ($1, $2)", [staff.body.id, staffRole[0].id]);
    staffToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: staffEmail, password: "pw123456" })).body.sessionToken;

    const supEmail = `gangrun-sup-${randomUUID()}@example.com`;
    const sup = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "Gang Run Supervisor", email: supEmail, password: "pw123456" });
    await pool.query("INSERT INTO identity_roles (identity_id, role_id) VALUES ($1, $2)", [sup.body.id, supRole[0].id]);
    supervisorToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: supEmail, password: "pw123456" })).body.sessionToken;
  });

  afterAll(async () => { await pool.end(); });

  async function importOrder(artworkIntent: "attachment" | "no" | "blank") {
    const res = await request(app).post("/api/orders/import").set("Authorization", `Bearer ${staffToken}`).send({
      idempotencyKey: randomUUID(), orgPrefix: "ANILYA", productName: "Gang Run Test Product", customerName: `Gang Run Customer ${randomUUID()}`, artworkIntent,
    });
    return res.body;
  }
  async function makePrintReady(orderId: string) {
    await request(app).post(`/api/orders/${orderId}/artwork/customer-upload`).set("Authorization", `Bearer ${staffToken}`).send({ fileReference: "a.pdf" });
    await request(app).post(`/api/orders/${orderId}/artwork/customer-approved`).set("Authorization", `Bearer ${staffToken}`).send({ fileReference: "b.pdf" });
    await request(app).post(`/api/orders/${orderId}/artwork/print-reviewed`).set("Authorization", `Bearer ${staffToken}`).send({ fileReference: "c.pdf" });
    await request(app).post(`/api/orders/${orderId}/artwork/print-approved`).set("Authorization", `Bearer ${supervisorToken}`).send({ fileReference: "d.pdf" });
  }

  it("CRITICAL (ART-004) — an order that is NOT yet print-ready cannot join a Gang Run", async () => {
    const order = await importOrder("attachment"); // no approval cycle run — definitely not print-ready
    const gangRun = await request(app).post("/api/gang-runs").set("Authorization", `Bearer ${supervisorToken}`).send({});

    const res = await request(app).post(`/api/gang-runs/${gangRun.body.id}/members`).set("Authorization", `Bearer ${supervisorToken}`).send({ orderId: order.id });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/print-ready/);
  });

  it("a genuinely print-ready order CAN join a Gang Run", async () => {
    const order = await importOrder("attachment");
    await makePrintReady(order.id);
    const gangRun = await request(app).post("/api/gang-runs").set("Authorization", `Bearer ${supervisorToken}`).send({});

    const res = await request(app).post(`/api/gang-runs/${gangRun.body.id}/members`).set("Authorization", `Bearer ${supervisorToken}`).send({ orderId: order.id });
    expect(res.status).toBe(201);

    const members = await request(app).get(`/api/gang-runs/${gangRun.body.id}/members`).set("Authorization", `Bearer ${supervisorToken}`);
    expect(members.body).toHaveLength(1);
    expect(members.body[0].id).toBe(order.id);
  });

  it("an order already in a Gang Run cannot be added to a second one", async () => {
    const order = await importOrder("attachment");
    await makePrintReady(order.id);
    const gangRunA = await request(app).post("/api/gang-runs").set("Authorization", `Bearer ${supervisorToken}`).send({});
    const gangRunB = await request(app).post("/api/gang-runs").set("Authorization", `Bearer ${supervisorToken}`).send({});

    await request(app).post(`/api/gang-runs/${gangRunA.body.id}/members`).set("Authorization", `Bearer ${supervisorToken}`).send({ orderId: order.id });
    const res = await request(app).post(`/api/gang-runs/${gangRunB.body.id}/members`).set("Authorization", `Bearer ${supervisorToken}`).send({ orderId: order.id });
    expect(res.status).toBe(409);
  });

  it("multiple print-ready orders can be pooled into the SAME Gang Run", async () => {
    const orderA = await importOrder("attachment");
    const orderB = await importOrder("no");
    await makePrintReady(orderA.id);
    await makePrintReady(orderB.id);
    const gangRun = await request(app).post("/api/gang-runs").set("Authorization", `Bearer ${supervisorToken}`).send({});

    await request(app).post(`/api/gang-runs/${gangRun.body.id}/members`).set("Authorization", `Bearer ${supervisorToken}`).send({ orderId: orderA.id });
    await request(app).post(`/api/gang-runs/${gangRun.body.id}/members`).set("Authorization", `Bearer ${supervisorToken}`).send({ orderId: orderB.id });

    const members = await request(app).get(`/api/gang-runs/${gangRun.body.id}/members`).set("Authorization", `Bearer ${supervisorToken}`);
    expect(members.body).toHaveLength(2);
  });

  it("completing a Gang Run works, and a completed Gang Run can no longer accept new members", async () => {
    const order = await importOrder("attachment");
    await makePrintReady(order.id);
    const gangRun = await request(app).post("/api/gang-runs").set("Authorization", `Bearer ${supervisorToken}`).send({});
    await request(app).post(`/api/gang-runs/${gangRun.body.id}/members`).set("Authorization", `Bearer ${supervisorToken}`).send({ orderId: order.id });

    const complete = await request(app).post(`/api/gang-runs/${gangRun.body.id}/complete`).set("Authorization", `Bearer ${supervisorToken}`).send({});
    expect(complete.status).toBe(200);
    expect(complete.body.status).toBe("completed");

    const secondOrder = await importOrder("attachment");
    await makePrintReady(secondOrder.id);
    const rejected = await request(app).post(`/api/gang-runs/${gangRun.body.id}/members`).set("Authorization", `Bearer ${supervisorToken}`).send({ orderId: secondOrder.id });
    expect(rejected.status).toBe(409);
  });

  it("ART-005 — member history survives after the Gang Run completes, fully queryable", async () => {
    const order = await importOrder("attachment");
    await makePrintReady(order.id);
    const gangRun = await request(app).post("/api/gang-runs").set("Authorization", `Bearer ${supervisorToken}`).send({});
    await request(app).post(`/api/gang-runs/${gangRun.body.id}/members`).set("Authorization", `Bearer ${supervisorToken}`).send({ orderId: order.id });
    await request(app).post(`/api/gang-runs/${gangRun.body.id}/complete`).set("Authorization", `Bearer ${supervisorToken}`).send({});

    const members = await request(app).get(`/api/gang-runs/${gangRun.body.id}/members`).set("Authorization", `Bearer ${supervisorToken}`);
    expect(members.body).toHaveLength(1); // still there, not deleted just because the shadow ID "closed"
  });

  it("a staff identity WITHOUT gangrun.manage cannot create a Gang Run (403)", async () => {
    const res = await request(app).post("/api/gang-runs").set("Authorization", `Bearer ${staffToken}`).send({});
    expect(res.status).toBe(403);
  });
});
