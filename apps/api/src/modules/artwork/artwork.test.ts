import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../server.js";
import { loadConfig } from "../../config/config.js";
import { createLogger } from "../../shared/logger.js";

describe("Artwork — the 4-stage workflow and the print-ready gate (ADR 0002)", () => {
  const config = loadConfig();
  const pool = new pg.Pool({
    host: config.PGHOST, port: config.PGPORT, user: config.PGUSER,
    password: config.PGPASSWORD, database: config.PGDATABASE,
  });
  const app = buildApp(config, pool, createLogger(config));

  let orgId: string;
  let staffToken: string;       // has orders.write + orders.import + orders.read, but NOT orders.artwork.approve
  let supervisorToken: string;  // additionally has orders.artwork.approve

  beforeAll(async () => {
    const { rows } = await pool.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [`Artwork Test ${randomUUID()}`, `artwork-test-${randomUUID()}`]);
    orgId = rows[0].id;

    for (const key of ["orders.import", "orders.read", "orders.write", "orders.artwork.approve"]) {
      await pool.query("INSERT INTO permissions (key, description) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [key, key]);
    }
    const { rows: staffRole } = await pool.query("INSERT INTO roles (organization_id, name) VALUES ($1, 'Artwork Staff') RETURNING id", [orgId]);
    for (const key of ["orders.import", "orders.read", "orders.write"]) {
      await pool.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = $2", [staffRole[0].id, key]);
    }
    const { rows: supRole } = await pool.query("INSERT INTO roles (organization_id, name) VALUES ($1, 'Artwork Supervisor') RETURNING id", [orgId]);
    for (const key of ["orders.import", "orders.read", "orders.write", "orders.artwork.approve"]) {
      await pool.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = $2", [supRole[0].id, key]);
    }

    const staffEmail = `artwork-staff-${randomUUID()}@example.com`;
    const staff = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "Artwork Staff", email: staffEmail, password: "pw123456" });
    await pool.query("INSERT INTO identity_roles (identity_id, role_id) VALUES ($1, $2)", [staff.body.id, staffRole[0].id]);
    staffToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: staffEmail, password: "pw123456" })).body.sessionToken;

    const supEmail = `artwork-sup-${randomUUID()}@example.com`;
    const sup = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "Artwork Supervisor", email: supEmail, password: "pw123456" });
    await pool.query("INSERT INTO identity_roles (identity_id, role_id) VALUES ($1, $2)", [sup.body.id, supRole[0].id]);
    supervisorToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: supEmail, password: "pw123456" })).body.sessionToken;
  });

  afterAll(async () => { await pool.end(); });

  async function importOrder(artworkIntent: "attachment" | "no" | "blank") {
    const res = await request(app).post("/api/orders/import").set("Authorization", `Bearer ${staffToken}`).send({
      idempotencyKey: randomUUID(), orgPrefix: "ANILYA", productName: "Artwork Test Product", customerName: `Artwork Customer ${randomUUID()}`, artworkIntent,
    });
    return res.body;
  }
  async function confirmOrder(orderId: string) {
    await request(app).post(`/api/orders/${orderId}/confirm`).set("Authorization", `Bearer ${staffToken}`).send({});
  }

  it("REGRESSION 1 (ADR 0002) — a 'blank'-intent order needs ZERO AMS interaction and starts production freely", async () => {
    const order = await importOrder("blank");
    await confirmOrder(order.id);
    const res = await request(app).post(`/api/orders/${order.id}/start`).set("Authorization", `Bearer ${staffToken}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe("in_progress");
  });

  it("REGRESSION 2 (ADR 0002) — customer approval ALONE is never sufficient to start production", async () => {
    const order = await importOrder("attachment");
    await confirmOrder(order.id);
    await request(app).post(`/api/orders/${order.id}/artwork/customer-upload`).set("Authorization", `Bearer ${staffToken}`).send({ fileReference: "original.pdf" });
    await request(app).post(`/api/orders/${order.id}/artwork/customer-approved`).set("Authorization", `Bearer ${staffToken}`).send({ fileReference: "customer_approved.pdf" });

    const res = await request(app).post(`/api/orders/${order.id}/start`).set("Authorization", `Bearer ${staffToken}`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not yet print-ready/);
  });

  it("print-approved is rejected (409) when no print-reviewed version exists yet — Stage 3 must happen before Stage 4", async () => {
    const order = await importOrder("attachment");
    const res = await request(app).post(`/api/orders/${order.id}/artwork/print-approved`).set("Authorization", `Bearer ${supervisorToken}`).send({ fileReference: "final.pdf" });
    expect(res.status).toBe(409);
  });

  it("the COMPLETE 4-stage flow makes an order print-ready, and only then can it start production", async () => {
    const order = await importOrder("attachment");
    await confirmOrder(order.id);

    await request(app).post(`/api/orders/${order.id}/artwork/customer-upload`).set("Authorization", `Bearer ${staffToken}`).send({ fileReference: "v1_original.pdf" });
    await request(app).post(`/api/orders/${order.id}/artwork/customer-approved`).set("Authorization", `Bearer ${staffToken}`).send({ fileReference: "v2_customer_approved.pdf" });
    await request(app).post(`/api/orders/${order.id}/artwork/print-reviewed`).set("Authorization", `Bearer ${staffToken}`).send({ fileReference: "v3_print_reviewed.pdf" });
    const approval = await request(app).post(`/api/orders/${order.id}/artwork/print-approved`).set("Authorization", `Bearer ${supervisorToken}`).send({ fileReference: "v4_print_approved.pdf" });
    expect(approval.status).toBe(201);

    const status = await request(app).get(`/api/orders/${order.id}/artwork/status`).set("Authorization", `Bearer ${staffToken}`);
    expect(status.body.print_ready).toBe(true);
    expect(status.body.ams_stage).toBeNull();

    const start = await request(app).post(`/api/orders/${order.id}/start`).set("Authorization", `Bearer ${staffToken}`).send({});
    expect(start.status).toBe(200);
  });

  it("the full version history shows all 4 stages in order, each a genuinely separate row", async () => {
    const order = await importOrder("attachment");
    await request(app).post(`/api/orders/${order.id}/artwork/customer-upload`).set("Authorization", `Bearer ${staffToken}`).send({ fileReference: "a.pdf" });
    await request(app).post(`/api/orders/${order.id}/artwork/customer-approved`).set("Authorization", `Bearer ${staffToken}`).send({ fileReference: "b.pdf" });
    await request(app).post(`/api/orders/${order.id}/artwork/print-reviewed`).set("Authorization", `Bearer ${staffToken}`).send({ fileReference: "c.pdf" });
    await request(app).post(`/api/orders/${order.id}/artwork/print-approved`).set("Authorization", `Bearer ${supervisorToken}`).send({ fileReference: "d.pdf" });

    const versions = await request(app).get(`/api/orders/${order.id}/artwork/versions`).set("Authorization", `Bearer ${staffToken}`);
    expect(versions.body).toHaveLength(4);
    expect(versions.body.map((v: { stage: string }) => v.stage)).toEqual(["customer_upload", "customer_approved_artwork", "print_reviewed", "print_approved"]);
  });

  it("CRITICAL RBAC — ordinary staff (orders.write but NOT orders.artwork.approve) cannot give the final print approval (403)", async () => {
    const order = await importOrder("attachment");
    await request(app).post(`/api/orders/${order.id}/artwork/print-reviewed`).set("Authorization", `Bearer ${staffToken}`).send({ fileReference: "x.pdf" });

    const res = await request(app).post(`/api/orders/${order.id}/artwork/print-approved`).set("Authorization", `Bearer ${staffToken}`).send({ fileReference: "y.pdf" });
    expect(res.status).toBe(403);
  });

  it("'no'-intent orders start at the artwork_creator stage, not artwork_verifier", async () => {
    const order = await importOrder("no");
    const status = await request(app).get(`/api/orders/${order.id}/artwork/status`).set("Authorization", `Bearer ${staffToken}`);
    expect(status.body.ams_stage).toBe("artwork_creator");
    expect(status.body.requires_artwork).toBe(true);
  });

  it("a 'blank'-intent order has requires_artwork = false and no ams_stage at all", async () => {
    const order = await importOrder("blank");
    const status = await request(app).get(`/api/orders/${order.id}/artwork/status`).set("Authorization", `Bearer ${staffToken}`);
    expect(status.body.requires_artwork).toBe(false);
    expect(status.body.ams_stage).toBeNull();
  });
});
