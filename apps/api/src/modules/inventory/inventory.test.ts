import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../server.js";
import { loadConfig } from "../../config/config.js";
import { createLogger } from "../../shared/logger.js";

describe("Inventory — INV-001/002/003/004/008", () => {
  const config = loadConfig();
  const pool = new pg.Pool({
    host: config.PGHOST, port: config.PGPORT, user: config.PGUSER,
    password: config.PGPASSWORD, database: config.PGDATABASE,
  });
  const app = buildApp(config, pool, createLogger(config));

  let orgId: string;
  let staffToken: string;
  let warehouseId: string;

  beforeAll(async () => {
    const { rows } = await pool.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [`Inventory Test ${randomUUID()}`, `inventory-test-${randomUUID()}`]);
    orgId = rows[0].id;

    for (const key of ["inventory.manage", "inventory.reserve", "inventory.read"]) {
      await pool.query("INSERT INTO permissions (key, description) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [key, key]);
    }
    const { rows: roleRows } = await pool.query("INSERT INTO roles (organization_id, name) VALUES ($1, 'Inventory Staff') RETURNING id", [orgId]);
    for (const key of ["inventory.manage", "inventory.reserve", "inventory.read"]) {
      await pool.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = $2", [roleRows[0].id, key]);
    }
    const staffEmail = `inv-staff-${randomUUID()}@example.com`;
    const staff = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "Inventory Staff", email: staffEmail, password: "pw123456" });
    await pool.query("INSERT INTO identity_roles (identity_id, role_id) VALUES ($1, $2)", [staff.body.id, roleRows[0].id]);
    staffToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: staffEmail, password: "pw123456" })).body.sessionToken;

    const wh = await request(app).post("/api/inventory/warehouses").set("Authorization", `Bearer ${staffToken}`).send({ name: "Main Warehouse", city: "Ranchi" });
    warehouseId = wh.body.id;
    await request(app).post(`/api/inventory/warehouses/${warehouseId}/set-default`).set("Authorization", `Bearer ${staffToken}`).send({});
  });

  afterAll(async () => { await pool.end(); });

  it("INV-008 fix — resolving with no explicit warehouse uses the organization's real configured default, not an accident of table order", async () => {
    const eventId = randomUUID();
    const res = await request(app).post("/api/inventory/events").set("Authorization", `Bearer ${staffToken}`).send({
      eventId, eventType: "STOCK_RECEIVED", source: "supplier-x", externalProductId: `ext-${randomUUID()}`, sku: `SKU-${randomUUID()}`, productName: "Default Warehouse Test", quantity: 50,
    });
    expect(res.status).toBe(201);
  });

  it("CRITICAL (INV-002) — replaying the exact same event_id is a safe no-op, stock increases exactly once", async () => {
    const eventId = randomUUID();
    const externalId = `ext-${randomUUID()}`;
    const sku = `SKU-${randomUUID()}`;
    const payload = { eventId, eventType: "STOCK_RECEIVED", source: "supplier-x", externalProductId: externalId, sku, productName: "Idempotency Test", quantity: 20, warehouseId };

    const first = await request(app).post("/api/inventory/events").set("Authorization", `Bearer ${staffToken}`).send(payload);
    const second = await request(app).post("/api/inventory/events").set("Authorization", `Bearer ${staffToken}`).send(payload);
    expect(first.status).toBe(201);
    expect(first.body.wasNew).toBe(true);
    expect(second.status).toBe(200);
    expect(second.body.wasNew).toBe(false);

    const { rows: productRows } = await pool.query(
      "SELECT p.id FROM inventory_products p JOIN inventory_product_external_map m ON m.product_id = p.id WHERE m.external_id = $1", [externalId]
    );
    const stock = await request(app).get(`/api/inventory/stock?productId=${productRows[0].id}&warehouseId=${warehouseId}`).set("Authorization", `Bearer ${staffToken}`);
    expect(stock.body.on_hand).toBe(20);
  });

  it("CRITICAL (INV-003) — a REAL concurrency test: 5 simultaneous reservations of 3 units each against 10 on hand — exactly 3 succeed, never negative", async () => {
    const eventId = randomUUID();
    const externalId = `ext-${randomUUID()}`;
    const productRes = await request(app).post("/api/inventory/events").set("Authorization", `Bearer ${staffToken}`).send({
      eventId, eventType: "STOCK_RECEIVED", source: "supplier-x", externalProductId: externalId, sku: `SKU-${randomUUID()}`, productName: "Concurrency Test", quantity: 10, warehouseId,
    });
    expect(productRes.status).toBe(201);
    const { rows: productRows } = await pool.query(
      "SELECT p.id FROM inventory_products p JOIN inventory_product_external_map m ON m.product_id = p.id WHERE m.external_id = $1", [externalId]
    );
    const productId = productRows[0].id;

    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        request(app).post("/api/inventory/reservations").set("Authorization", `Bearer ${staffToken}`).send({ productId, warehouseId, quantity: 3 })
      )
    );
    const succeeded = attempts.filter((a) => a.status === "fulfilled" && (a.value as { status: number }).status === 201);
    const failed = attempts.filter((a) => a.status === "fulfilled" && (a.value as { status: number }).status === 409);

    expect(succeeded).toHaveLength(3);
    expect(failed).toHaveLength(2);

    const stock = await request(app).get(`/api/inventory/stock?productId=${productId}&warehouseId=${warehouseId}`).set("Authorization", `Bearer ${staffToken}`);
    expect(stock.body.reserved).toBe(9);
    expect(stock.body.available).toBe(1);
  });

  it("INV-004 — the ledger snapshot records the correct previous/new on_hand for every movement", async () => {
    const eventId = randomUUID();
    const externalId = `ext-${randomUUID()}`;
    await request(app).post("/api/inventory/events").set("Authorization", `Bearer ${staffToken}`).send({
      eventId, eventType: "STOCK_RECEIVED", source: "supplier-x", externalProductId: externalId, sku: `SKU-${randomUUID()}`, productName: "Ledger Test", quantity: 15, warehouseId,
    });
    const { rows: productRows } = await pool.query(
      "SELECT p.id FROM inventory_products p JOIN inventory_product_external_map m ON m.product_id = p.id WHERE m.external_id = $1", [externalId]
    );
    const ledger = await request(app).get(`/api/inventory/ledger?productId=${productRows[0].id}&warehouseId=${warehouseId}`).set("Authorization", `Bearer ${staffToken}`);
    expect(ledger.body).toHaveLength(1);
    expect(ledger.body[0].movement_type).toBe("inbound");
    expect(ledger.body[0].previous_on_hand).toBe(0);
    expect(ledger.body[0].new_on_hand).toBe(15);
  });

  it("releasing a reservation frees the reserved quantity but leaves on_hand unchanged", async () => {
    const eventId = randomUUID();
    const externalId = `ext-${randomUUID()}`;
    await request(app).post("/api/inventory/events").set("Authorization", `Bearer ${staffToken}`).send({
      eventId, eventType: "STOCK_RECEIVED", source: "supplier-x", externalProductId: externalId, sku: `SKU-${randomUUID()}`, productName: "Release Test", quantity: 10, warehouseId,
    });
    const { rows: productRows } = await pool.query(
      "SELECT p.id FROM inventory_products p JOIN inventory_product_external_map m ON m.product_id = p.id WHERE m.external_id = $1", [externalId]
    );
    const productId = productRows[0].id;
    const reservation = await request(app).post("/api/inventory/reservations").set("Authorization", `Bearer ${staffToken}`).send({ productId, warehouseId, quantity: 4 });

    await request(app).post(`/api/inventory/reservations/${reservation.body.id}/release`).set("Authorization", `Bearer ${staffToken}`).send({});
    const stock = await request(app).get(`/api/inventory/stock?productId=${productId}&warehouseId=${warehouseId}`).set("Authorization", `Bearer ${staffToken}`);
    expect(stock.body.reserved).toBe(0);
    expect(stock.body.on_hand).toBe(10);
  });

  it("consuming a reservation reduces BOTH on_hand and reserved", async () => {
    const eventId = randomUUID();
    const externalId = `ext-${randomUUID()}`;
    await request(app).post("/api/inventory/events").set("Authorization", `Bearer ${staffToken}`).send({
      eventId, eventType: "STOCK_RECEIVED", source: "supplier-x", externalProductId: externalId, sku: `SKU-${randomUUID()}`, productName: "Consume Test", quantity: 10, warehouseId,
    });
    const { rows: productRows } = await pool.query(
      "SELECT p.id FROM inventory_products p JOIN inventory_product_external_map m ON m.product_id = p.id WHERE m.external_id = $1", [externalId]
    );
    const productId = productRows[0].id;
    const reservation = await request(app).post("/api/inventory/reservations").set("Authorization", `Bearer ${staffToken}`).send({ productId, warehouseId, quantity: 4 });

    await request(app).post(`/api/inventory/reservations/${reservation.body.id}/consume`).set("Authorization", `Bearer ${staffToken}`).send({});
    const stock = await request(app).get(`/api/inventory/stock?productId=${productId}&warehouseId=${warehouseId}`).set("Authorization", `Bearer ${staffToken}`);
    expect(stock.body.reserved).toBe(0);
    expect(stock.body.on_hand).toBe(6);
  });

  it("consuming an already-consumed reservation a second time is rejected (409)", async () => {
    const eventId = randomUUID();
    const externalId = `ext-${randomUUID()}`;
    await request(app).post("/api/inventory/events").set("Authorization", `Bearer ${staffToken}`).send({
      eventId, eventType: "STOCK_RECEIVED", source: "supplier-x", externalProductId: externalId, sku: `SKU-${randomUUID()}`, productName: "Double Consume Test", quantity: 10, warehouseId,
    });
    const { rows: productRows } = await pool.query(
      "SELECT p.id FROM inventory_products p JOIN inventory_product_external_map m ON m.product_id = p.id WHERE m.external_id = $1", [externalId]
    );
    const reservation = await request(app).post("/api/inventory/reservations").set("Authorization", `Bearer ${staffToken}`).send({ productId: productRows[0].id, warehouseId, quantity: 2 });
    await request(app).post(`/api/inventory/reservations/${reservation.body.id}/consume`).set("Authorization", `Bearer ${staffToken}`).send({});
    const res = await request(app).post(`/api/inventory/reservations/${reservation.body.id}/consume`).set("Authorization", `Bearer ${staffToken}`).send({});
    expect(res.status).toBe(409);
  });

  it("a staff identity without inventory.reserve cannot create a reservation (403)", async () => {
    const email = `inv-noperm-${randomUUID()}@example.com`;
    await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "No Perm", email, password: "pw123456" });
    const token = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email, password: "pw123456" })).body.sessionToken;
    const res = await request(app).post("/api/inventory/reservations").set("Authorization", `Bearer ${token}`).send({ productId: randomUUID(), warehouseId, quantity: 1 });
    expect(res.status).toBe(403);
  });
});
