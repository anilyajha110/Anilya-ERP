import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../server.js";
import { loadConfig } from "../../config/config.js";
import { createLogger } from "../../shared/logger.js";

describe("Orders — idempotent import, state machine, tracking", () => {
  const config = loadConfig();
  const pool = new pg.Pool({
    host: config.PGHOST, port: config.PGPORT, user: config.PGUSER,
    password: config.PGPASSWORD, database: config.PGDATABASE,
  });
  const app = buildApp(config, pool, createLogger(config));

  let orgId: string;
  let staffToken: string;

  beforeAll(async () => {
    const { rows } = await pool.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [`Orders Test ${randomUUID()}`, `orders-test-${randomUUID()}`]);
    orgId = rows[0].id;

    // Grant a staff identity every permission this test suite needs.
    const permKeys = ["orders.import", "orders.read", "orders.write"];
    for (const key of permKeys) {
      await pool.query("INSERT INTO permissions (key, description) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [key, key]);
    }
    const { rows: roleRows } = await pool.query("INSERT INTO roles (organization_id, name) VALUES ($1, 'Orders Staff') RETURNING id", [orgId]);
    for (const key of permKeys) {
      await pool.query(
        "INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = $2",
        [roleRows[0].id, key]
      );
    }
    const staffEmail = `orders-staff-${randomUUID()}@example.com`;
    const staff = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "Orders Staff", email: staffEmail, password: "pw123456" });
    await pool.query("INSERT INTO identity_roles (identity_id, role_id) VALUES ($1, $2)", [staff.body.id, roleRows[0].id]);
    staffToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: staffEmail, password: "pw123456" })).body.sessionToken;
  });

  afterAll(async () => { await pool.end(); });

  it("creates a new order on first import", async () => {
    const key = randomUUID();
    const res = await request(app).post("/api/orders/import").set("Authorization", `Bearer ${staffToken}`).send({
      idempotencyKey: key, orgPrefix: "ANILYA", productName: "Business Cards", customerName: "Ramesh Kumar", customerPhone: "9990001111",
    });
    expect(res.status).toBe(201);
    expect(res.body.wasNew).toBe(true);
    expect(res.body.stage).toBe("imported");
    expect(res.body.display_order_number).toMatch(/^ANILYA\/\d{4}\/\d{2}\/\d{5}$/);
  });

  it("CRITICAL — replaying the exact same idempotencyKey returns the SAME order, never a duplicate (fixes RISK-007)", async () => {
    const key = randomUUID();
    const first = await request(app).post("/api/orders/import").set("Authorization", `Bearer ${staffToken}`).send({
      idempotencyKey: key, orgPrefix: "ANILYA", productName: "Visiting Cards", customerName: "Duplicate Test Customer",
    });
    const second = await request(app).post("/api/orders/import").set("Authorization", `Bearer ${staffToken}`).send({
      idempotencyKey: key, orgPrefix: "ANILYA", productName: "Visiting Cards", customerName: "Duplicate Test Customer",
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200); // not 201 — nothing new was created
    expect(second.body.wasNew).toBe(false);
    expect(second.body.id).toBe(first.body.id); // literally the same order

    const { rows } = await pool.query("SELECT COUNT(*) FROM orders WHERE idempotency_key = $1", [key]);
    expect(Number(rows[0].count)).toBe(1); // exactly one row in the database, not two
  });

  it("display order numbers increment correctly and never collide under back-to-back imports", async () => {
    const a = await request(app).post("/api/orders/import").set("Authorization", `Bearer ${staffToken}`).send({
      idempotencyKey: randomUUID(), orgPrefix: "ANILYA", productName: "A", customerName: "Sequence Test A",
    });
    const b = await request(app).post("/api/orders/import").set("Authorization", `Bearer ${staffToken}`).send({
      idempotencyKey: randomUUID(), orgPrefix: "ANILYA", productName: "B", customerName: "Sequence Test B",
    });
    expect(a.body.display_order_number).not.toBe(b.body.display_order_number);
  });

  it("valid transition (confirm) succeeds and is captured in the audit log with old/new stage", async () => {
    const created = await request(app).post("/api/orders/import").set("Authorization", `Bearer ${staffToken}`).send({
      idempotencyKey: randomUUID(), orgPrefix: "ANILYA", productName: "Transition Test", customerName: "Transition Customer",
    });
    const res = await request(app).post(`/api/orders/${created.body.id}/confirm`).set("Authorization", `Bearer ${staffToken}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe("confirmed");

    const { rows } = await pool.query("SELECT old_value, new_value FROM audit_log WHERE entity_id = $1 AND action_type = 'order.confirm'", [created.body.id]);
    expect(rows[0].old_value).toBe("imported");
    expect(rows[0].new_value).toBe("confirmed");
  });

  it("an invalid transition (completing an order that was never started) is rejected (409), not silently applied", async () => {
    const created = await request(app).post("/api/orders/import").set("Authorization", `Bearer ${staffToken}`).send({
      idempotencyKey: randomUUID(), orgPrefix: "ANILYA", productName: "Invalid Transition Test", customerName: "Invalid Transition Customer",
    });
    const res = await request(app).post(`/api/orders/${created.body.id}/complete`).set("Authorization", `Bearer ${staffToken}`).send({});
    expect(res.status).toBe(409);
  });

  it("cancelling without a reason is rejected (400)", async () => {
    const created = await request(app).post("/api/orders/import").set("Authorization", `Bearer ${staffToken}`).send({
      idempotencyKey: randomUUID(), orgPrefix: "ANILYA", productName: "Cancel Reason Test", customerName: "Cancel Reason Customer",
    });
    const res = await request(app).post(`/api/orders/${created.body.id}/cancel`).set("Authorization", `Bearer ${staffToken}`).send({});
    expect(res.status).toBe(400);
  });

  it("a completed order can never be cancelled — cancellation is only valid before completion", async () => {
    const created = await request(app).post("/api/orders/import").set("Authorization", `Bearer ${staffToken}`).send({
      idempotencyKey: randomUUID(), orgPrefix: "ANILYA", productName: "Completed Cancel Test", customerName: "Completed Cancel Customer",
    });
    await request(app).post(`/api/orders/${created.body.id}/confirm`).set("Authorization", `Bearer ${staffToken}`).send({});
    await request(app).post(`/api/orders/${created.body.id}/start`).set("Authorization", `Bearer ${staffToken}`).send({});
    await request(app).post(`/api/orders/${created.body.id}/complete`).set("Authorization", `Bearer ${staffToken}`).send({});

    const res = await request(app).post(`/api/orders/${created.body.id}/cancel`).set("Authorization", `Bearer ${staffToken}`).send({ reason: "changed my mind" });
    expect(res.status).toBe(409);
  });

  it("CRITICAL — the public tracking endpoint never includes phone or email (fixes ORD-005), even though the order has them", async () => {
    const created = await request(app).post("/api/orders/import").set("Authorization", `Bearer ${staffToken}`).send({
      idempotencyKey: randomUUID(), orgPrefix: "ANILYA", productName: "Privacy Test", customerName: "Privacy Customer",
      customerPhone: "9998887777", shippingAddress: "123 Main Street, Ranchi",
    });
    const track = await request(app).get(`/track/${created.body.tracking_token}`);
    expect(track.status).toBe(200);
    expect(track.body.stage).toBe("imported");
    expect(track.body.shippingAddress).toBe("123 Main Street, Ranchi");
    expect(JSON.stringify(track.body)).not.toContain("9998887777"); // the phone number appears NOWHERE in the public response
    expect(track.body.phone).toBeUndefined();
    expect(track.body.email).toBeUndefined();
  });

  it("tracking a nonexistent token returns 404, not a leaked error", async () => {
    const res = await request(app).get(`/track/${randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it("a customer sees only their OWN orders via /orders/me", async () => {
    const emailA = `orders-customer-a-${randomUUID()}@example.com`;
    await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "customer", displayName: "Order Customer A", email: emailA, password: "pw123456" });
    const tokenA = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: emailA, password: "pw123456" })).body.sessionToken;

    // Staff creates an order for a DIFFERENT customer by name — this
    // won't match Customer A's identity, so their /orders/me must stay empty.
    await request(app).post("/api/orders/import").set("Authorization", `Bearer ${staffToken}`).send({
      idempotencyKey: randomUUID(), orgPrefix: "ANILYA", productName: "Someone Else's Order", customerName: "A Totally Different Customer",
    });

    const mine = await request(app).get("/api/orders/me").set("Authorization", `Bearer ${tokenA}`);
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual([]); // none of the above orders belong to Customer A
  });

  it("a staff identity WITHOUT orders.import cannot import an order (403)", async () => {
    const email = `no-perm-staff-${randomUUID()}@example.com`;
    await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "No Permission Staff", email, password: "pw123456" });
    const token = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email, password: "pw123456" })).body.sessionToken;

    const res = await request(app).post("/api/orders/import").set("Authorization", `Bearer ${token}`).send({
      idempotencyKey: randomUUID(), orgPrefix: "ANILYA", productName: "Should Not Work", customerName: "Should Not Work Customer",
    });
    expect(res.status).toBe(403);
  });
});
