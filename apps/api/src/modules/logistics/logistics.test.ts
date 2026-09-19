import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../server.js";
import { loadConfig } from "../../config/config.js";
import { createLogger } from "../../shared/logger.js";

describe("Logistics — LOG-001 (parcel cascade) and LOG-002 (split isolation)", () => {
  const config = loadConfig();
  const pool = new pg.Pool({
    host: config.PGHOST, port: config.PGPORT, user: config.PGUSER,
    password: config.PGPASSWORD, database: config.PGDATABASE,
  });
  const app = buildApp(config, pool, createLogger(config));

  let orgId: string;
  let staffToken: string;

  beforeAll(async () => {
    const { rows } = await pool.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [`Logistics Test ${randomUUID()}`, `logistics-test-${randomUUID()}`]);
    orgId = rows[0].id;

    for (const key of ["orders.import", "orders.read", "orders.write", "logistics.manage"]) {
      await pool.query("INSERT INTO permissions (key, description) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [key, key]);
    }
    const { rows: staffRole } = await pool.query("INSERT INTO roles (organization_id, name) VALUES ($1, 'Logistics Staff') RETURNING id", [orgId]);
    for (const key of ["orders.import", "orders.read", "orders.write", "logistics.manage"]) {
      await pool.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = $2", [staffRole[0].id, key]);
    }
    const staffEmail = `log-staff-${randomUUID()}@example.com`;
    const staff = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "Logistics Staff", email: staffEmail, password: "pw123456" });
    await pool.query("INSERT INTO identity_roles (identity_id, role_id) VALUES ($1, $2)", [staff.body.id, staffRole[0].id]);
    staffToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: staffEmail, password: "pw123456" })).body.sessionToken;
  });

  afterAll(async () => { await pool.end(); });

  async function importCompletedOrder() {
    const order = await request(app).post("/api/orders/import").set("Authorization", `Bearer ${staffToken}`).send({
      idempotencyKey: randomUUID(), orgPrefix: "ANILYA", productName: "Logistics Test Product", customerName: `Logistics Customer ${randomUUID()}`, artworkIntent: "blank",
    });
    await request(app).post(`/api/orders/${order.body.id}/confirm`).set("Authorization", `Bearer ${staffToken}`).send({});
    await request(app).post(`/api/orders/${order.body.id}/start`).set("Authorization", `Bearer ${staffToken}`).send({});
    await request(app).post(`/api/orders/${order.body.id}/complete`).set("Authorization", `Bearer ${staffToken}`).send({});
    return order.body.id;
  }
  async function createParcel() {
    const res = await request(app).post("/api/parcels").set("Authorization", `Bearer ${staffToken}`).send({ courierReference: `AWB-${randomUUID()}` });
    return res.body.id;
  }

  it("an order that isn't 'completed' yet cannot be added to a parcel (409)", async () => {
    const order = await request(app).post("/api/orders/import").set("Authorization", `Bearer ${staffToken}`).send({
      idempotencyKey: randomUUID(), orgPrefix: "ANILYA", productName: "Not Ready", customerName: "Not Ready Customer", artworkIntent: "blank",
    });
    const parcelId = await createParcel();
    const res = await request(app).post(`/api/parcels/${parcelId}/orders`).set("Authorization", `Bearer ${staffToken}`).send({ orderId: order.body.id });
    expect(res.status).toBe(409);
  });

  it("CRITICAL (LOG-001) — dispatching a parcel cascades to EVERY member order", async () => {
    const orderA = await importCompletedOrder();
    const orderB = await importCompletedOrder();
    const parcelId = await createParcel();
    await request(app).post(`/api/parcels/${parcelId}/orders`).set("Authorization", `Bearer ${staffToken}`).send({ orderId: orderA });
    await request(app).post(`/api/parcels/${parcelId}/orders`).set("Authorization", `Bearer ${staffToken}`).send({ orderId: orderB });

    const dispatch = await request(app).post(`/api/parcels/${parcelId}/dispatch`).set("Authorization", `Bearer ${staffToken}`).send({});
    expect(dispatch.status).toBe(200);
    expect(dispatch.body.status).toBe("dispatched");

    const [a, b] = await Promise.all([
      request(app).get(`/api/orders/${orderA}`).set("Authorization", `Bearer ${staffToken}`),
      request(app).get(`/api/orders/${orderB}`).set("Authorization", `Bearer ${staffToken}`),
    ]);
    expect(a.body.stage).toBe("dispatched");
    expect(b.body.stage).toBe("dispatched");
  });

  it("CRITICAL — the full cascade chain (dispatch -> out-for-delivery -> deliver) carries every member all the way to 'delivered'", async () => {
    const orderA = await importCompletedOrder();
    const parcelId = await createParcel();
    await request(app).post(`/api/parcels/${parcelId}/orders`).set("Authorization", `Bearer ${staffToken}`).send({ orderId: orderA });

    await request(app).post(`/api/parcels/${parcelId}/dispatch`).set("Authorization", `Bearer ${staffToken}`).send({});
    await request(app).post(`/api/parcels/${parcelId}/out-for-delivery`).set("Authorization", `Bearer ${staffToken}`).send({});
    const deliver = await request(app).post(`/api/parcels/${parcelId}/deliver`).set("Authorization", `Bearer ${staffToken}`).send({});
    expect(deliver.status).toBe(200);
    expect(deliver.body.status).toBe("delivered");

    const order = await request(app).get(`/api/orders/${orderA}`).set("Authorization", `Bearer ${staffToken}`);
    expect(order.body.stage).toBe("delivered");
  });

  it("CRITICAL (LOG-002) — an order split OUT before dispatch is completely unaffected by the parcel's later cascade", async () => {
    const orderA = await importCompletedOrder();
    const orderB = await importCompletedOrder();
    const parcelId = await createParcel();
    await request(app).post(`/api/parcels/${parcelId}/orders`).set("Authorization", `Bearer ${staffToken}`).send({ orderId: orderA });
    await request(app).post(`/api/parcels/${parcelId}/orders`).set("Authorization", `Bearer ${staffToken}`).send({ orderId: orderB });

    // Split B out BEFORE dispatch.
    const split = await request(app).delete(`/api/parcels/orders/${orderB}`).set("Authorization", `Bearer ${staffToken}`).send({});
    expect(split.status).toBe(200);

    await request(app).post(`/api/parcels/${parcelId}/dispatch`).set("Authorization", `Bearer ${staffToken}`).send({});

    const [a, b] = await Promise.all([
      request(app).get(`/api/orders/${orderA}`).set("Authorization", `Bearer ${staffToken}`),
      request(app).get(`/api/orders/${orderB}`).set("Authorization", `Bearer ${staffToken}`),
    ]);
    expect(a.body.stage).toBe("dispatched"); // still in the parcel — cascaded
    expect(b.body.stage).toBe("completed");  // split out — completely untouched by the dispatch
  });

  it("an order already in one parcel cannot be added to a second parcel (409)", async () => {
    const orderA = await importCompletedOrder();
    const parcel1 = await createParcel();
    const parcel2 = await createParcel();
    await request(app).post(`/api/parcels/${parcel1}/orders`).set("Authorization", `Bearer ${staffToken}`).send({ orderId: orderA });
    const res = await request(app).post(`/api/parcels/${parcel2}/orders`).set("Authorization", `Bearer ${staffToken}`).send({ orderId: orderA });
    expect(res.status).toBe(409);
  });

  it("dispatching an already-dispatched parcel a second time is rejected (409)", async () => {
    const orderA = await importCompletedOrder();
    const parcelId = await createParcel();
    await request(app).post(`/api/parcels/${parcelId}/orders`).set("Authorization", `Bearer ${staffToken}`).send({ orderId: orderA });
    await request(app).post(`/api/parcels/${parcelId}/dispatch`).set("Authorization", `Bearer ${staffToken}`).send({});
    const res = await request(app).post(`/api/parcels/${parcelId}/dispatch`).set("Authorization", `Bearer ${staffToken}`).send({});
    expect(res.status).toBe(409);
  });

  it("REGRESSION — a non-parcelled order can still go straight 'completed' -> 'delivered' (Phase 9's original direct path still works)", async () => {
    const orderA = await importCompletedOrder();
    const res = await request(app).post(`/api/orders/${orderA}/deliver`).set("Authorization", `Bearer ${staffToken}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe("delivered");
  });

  it("a staff identity without logistics.manage cannot create a parcel (403)", async () => {
    const email = `log-noperm-${randomUUID()}@example.com`;
    await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "No Perm", email, password: "pw123456" });
    const token = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email, password: "pw123456" })).body.sessionToken;
    const res = await request(app).post("/api/parcels").set("Authorization", `Bearer ${token}`).send({});
    expect(res.status).toBe(403);
  });
});
