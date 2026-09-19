import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../server.js";
import { loadConfig } from "../../config/config.js";
import { createLogger } from "../../shared/logger.js";

describe("Finance — FIN-001 (delivered-only invoicing) and FIN-002 (OTP-protected download)", () => {
  const config = loadConfig();
  const pool = new pg.Pool({
    host: config.PGHOST, port: config.PGPORT, user: config.PGUSER,
    password: config.PGPASSWORD, database: config.PGDATABASE,
  });
  const app = buildApp(config, pool, createLogger(config));

  let orgId: string;
  let staffToken: string;

  beforeAll(async () => {
    const { rows } = await pool.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [`Finance Test ${randomUUID()}`, `finance-test-${randomUUID()}`]);
    orgId = rows[0].id;

    for (const key of ["orders.import", "orders.write", "invoices.generate", "invoices.read"]) {
      await pool.query("INSERT INTO permissions (key, description) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [key, key]);
    }
    const { rows: staffRole } = await pool.query("INSERT INTO roles (organization_id, name) VALUES ($1, 'Finance Staff') RETURNING id", [orgId]);
    for (const key of ["orders.import", "orders.write", "invoices.generate", "invoices.read"]) {
      await pool.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = $2", [staffRole[0].id, key]);
    }
    const staffEmail = `fin-staff-${randomUUID()}@example.com`;
    const staff = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "Finance Staff", email: staffEmail, password: "pw123456" });
    await pool.query("INSERT INTO identity_roles (identity_id, role_id) VALUES ($1, $2)", [staff.body.id, staffRole[0].id]);
    staffToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: staffEmail, password: "pw123456" })).body.sessionToken;
  });

  afterAll(async () => { await pool.end(); });

  async function importOrder(orderValue = 1000) {
    const res = await request(app).post("/api/orders/import").set("Authorization", `Bearer ${staffToken}`).send({
      idempotencyKey: randomUUID(), orgPrefix: "ANILYA", productName: "Finance Test Product", customerName: `Finance Customer ${randomUUID()}`, artworkIntent: "blank", orderValue,
    });
    return res.body;
  }
  async function driveToStage(orderId: string, stage: "completed" | "delivered") {
    await request(app).post(`/api/orders/${orderId}/confirm`).set("Authorization", `Bearer ${staffToken}`).send({});
    await request(app).post(`/api/orders/${orderId}/start`).set("Authorization", `Bearer ${staffToken}`).send({});
    await request(app).post(`/api/orders/${orderId}/complete`).set("Authorization", `Bearer ${staffToken}`).send({});
    if (stage === "delivered") await request(app).post(`/api/orders/${orderId}/deliver`).set("Authorization", `Bearer ${staffToken}`).send({});
  }

  it("CRITICAL (FIN-001) — an order that is only 'completed' (not yet delivered) cannot be invoiced", async () => {
    const order = await importOrder();
    await driveToStage(order.id, "completed");
    const res = await request(app).post(`/api/orders/${order.id}/invoice`).set("Authorization", `Bearer ${staffToken}`).send({ orgPrefix: "ANILYA" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("completed");
  });

  it("CRITICAL (FIN-001, inverse) — a genuinely 'delivered' order CAN be invoiced, for the exact order_value", async () => {
    const order = await importOrder(2500);
    await driveToStage(order.id, "delivered");
    const res = await request(app).post(`/api/orders/${order.id}/invoice`).set("Authorization", `Bearer ${staffToken}`).send({ orgPrefix: "ANILYA" });
    expect(res.status).toBe(201);
    expect(Number(res.body.amount)).toBe(2500);
    expect(res.body.invoice_number).toMatch(/^ANILYA\/INV\/\d{4}\/\d{5}$/);
  });

  it("a second invoice for the same order is rejected (409) — one invoice per order", async () => {
    const order = await importOrder();
    await driveToStage(order.id, "delivered");
    await request(app).post(`/api/orders/${order.id}/invoice`).set("Authorization", `Bearer ${staffToken}`).send({ orgPrefix: "ANILYA" });
    const res = await request(app).post(`/api/orders/${order.id}/invoice`).set("Authorization", `Bearer ${staffToken}`).send({ orgPrefix: "ANILYA" });
    expect(res.status).toBe(409);
  });

  it("a staff identity without invoices.generate cannot generate an invoice (403)", async () => {
    const email = `fin-noperm-${randomUUID()}@example.com`;
    await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "No Perm", email, password: "pw123456" });
    const token = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email, password: "pw123456" })).body.sessionToken;

    const order = await importOrder();
    await driveToStage(order.id, "delivered");
    const res = await request(app).post(`/api/orders/${order.id}/invoice`).set("Authorization", `Bearer ${token}`).send({ orgPrefix: "ANILYA" });
    expect(res.status).toBe(403);
  });
});

describe("Finance — OTP-protected customer download (FIN-002)", () => {
  const config = loadConfig();
  const pool = new pg.Pool({
    host: config.PGHOST, port: config.PGPORT, user: config.PGUSER,
    password: config.PGPASSWORD, database: config.PGDATABASE,
  });
  const app = buildApp(config, pool, createLogger(config));

  let orgId: string;
  let staffToken: string;
  let ownerToken: string;   // the customer who actually owns the order/invoice
  let strangerToken: string; // a different customer, must never see this invoice
  let invoiceId: string;

  beforeAll(async () => {
    const { rows } = await pool.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [`Invoice OTP Test ${randomUUID()}`, `invoice-otp-test-${randomUUID()}`]);
    orgId = rows[0].id;

    for (const key of ["orders.import", "orders.write", "invoices.generate"]) {
      await pool.query("INSERT INTO permissions (key, description) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [key, key]);
    }
    const { rows: staffRole } = await pool.query("INSERT INTO roles (organization_id, name) VALUES ($1, 'Invoice OTP Staff') RETURNING id", [orgId]);
    for (const key of ["orders.import", "orders.write", "invoices.generate"]) {
      await pool.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = $2", [staffRole[0].id, key]);
    }
    const staffEmail = `iotp-staff-${randomUUID()}@example.com`;
    const staff = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "Invoice OTP Staff", email: staffEmail, password: "pw123456" });
    await pool.query("INSERT INTO identity_roles (identity_id, role_id) VALUES ($1, $2)", [staff.body.id, staffRole[0].id]);
    staffToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: staffEmail, password: "pw123456" })).body.sessionToken;

    // A real customer identity with a registered phone — the CUSTOMER
    // themself must not need to log in as this identity to own the
    // order; findOrCreateCustomer (Phase 3) creates it during import.
    const customerPhone = `9${randomUUID().replace(/\D/g, "").slice(0, 9)}`;
    const order = await request(app).post("/api/orders/import").set("Authorization", `Bearer ${staffToken}`).send({
      idempotencyKey: randomUUID(), orgPrefix: "ANILYA", productName: "OTP Test Product", customerName: "OTP Owner Customer", customerPhone, artworkIntent: "blank", orderValue: 999,
    });
    await request(app).post(`/api/orders/${order.body.id}/confirm`).set("Authorization", `Bearer ${staffToken}`).send({});
    await request(app).post(`/api/orders/${order.body.id}/start`).set("Authorization", `Bearer ${staffToken}`).send({});
    await request(app).post(`/api/orders/${order.body.id}/complete`).set("Authorization", `Bearer ${staffToken}`).send({});
    await request(app).post(`/api/orders/${order.body.id}/deliver`).set("Authorization", `Bearer ${staffToken}`).send({});
    const invoice = await request(app).post(`/api/orders/${order.body.id}/invoice`).set("Authorization", `Bearer ${staffToken}`).send({ orgPrefix: "ANILYA" });
    invoiceId = invoice.body.id;

    // Log in as that SAME customer identity — need a password on it.
    // findOrCreateCustomer doesn't set one, so set it directly for the
    // test's own login purposes (in real usage this customer would use
    // OTP login, not password — irrelevant to what's being tested here).
    const { rows: custRows } = await pool.query("SELECT id FROM identities WHERE phone = $1", [customerPhone]);
    const { hashPassword } = await import("../identity/password.js");
    await pool.query("UPDATE identities SET password_hash = $1, email = $2 WHERE id = $3", [await hashPassword("pw123456"), `owner-${randomUUID()}@example.com`, custRows[0].id]);
    const { rows: emailRow } = await pool.query("SELECT email FROM identities WHERE id = $1", [custRows[0].id]);
    ownerToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: emailRow[0].email, password: "pw123456" })).body.sessionToken;

    const strangerEmail = `stranger-${randomUUID()}@example.com`;
    await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "customer", displayName: "Stranger Customer", email: strangerEmail, password: "pw123456" });
    strangerToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: strangerEmail, password: "pw123456" })).body.sessionToken;
  });

  afterAll(async () => { await pool.end(); });

  it("CRITICAL — a different customer cannot even request an OTP for someone else's invoice (403)", async () => {
    const res = await request(app).post(`/api/invoices/${invoiceId}/download/request-otp`).set("Authorization", `Bearer ${strangerToken}`).send({});
    expect(res.status).toBe(403);
  });

  it("the genuine owner can request an OTP, hashed in the database, never the raw code", async () => {
    const res = await request(app).post(`/api/invoices/${invoiceId}/download/request-otp`).set("Authorization", `Bearer ${ownerToken}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.otpRequestId).toBeTruthy();
    expect(res.body.demoOtp).toMatch(/^\d{6}$/);

    const { rows } = await pool.query("SELECT otp_hash FROM otp_requests WHERE id = $1", [res.body.otpRequestId]);
    expect(rows[0].otp_hash).not.toBe(res.body.demoOtp); // hashed, never the raw code
  });

  it("verifying with the WRONG code is rejected (401) and decrements attempts remaining", async () => {
    const req1 = await request(app).post(`/api/invoices/${invoiceId}/download/request-otp`).set("Authorization", `Bearer ${ownerToken}`).send({});
    const res = await request(app).post(`/api/invoices/${invoiceId}/download/verify-otp`).set("Authorization", `Bearer ${ownerToken}`).send({ otpRequestId: req1.body.otpRequestId, code: "000000" });
    expect(res.status).toBe(401);
    expect(res.body.attemptsRemaining).toBe(2);
  });

  it("CRITICAL — verifying with the CORRECT code succeeds and returns the invoice", async () => {
    const req1 = await request(app).post(`/api/invoices/${invoiceId}/download/request-otp`).set("Authorization", `Bearer ${ownerToken}`).send({});
    const res = await request(app).post(`/api/invoices/${invoiceId}/download/verify-otp`).set("Authorization", `Bearer ${ownerToken}`).send({ otpRequestId: req1.body.otpRequestId, code: req1.body.demoOtp });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(invoiceId);
  });

  it("after 3 incorrect attempts, the OTP is locked out (401) even with a fresh correct guess", async () => {
    const req1 = await request(app).post(`/api/invoices/${invoiceId}/download/request-otp`).set("Authorization", `Bearer ${ownerToken}`).send({});
    await request(app).post(`/api/invoices/${invoiceId}/download/verify-otp`).set("Authorization", `Bearer ${ownerToken}`).send({ otpRequestId: req1.body.otpRequestId, code: "111111" });
    await request(app).post(`/api/invoices/${invoiceId}/download/verify-otp`).set("Authorization", `Bearer ${ownerToken}`).send({ otpRequestId: req1.body.otpRequestId, code: "222222" });
    await request(app).post(`/api/invoices/${invoiceId}/download/verify-otp`).set("Authorization", `Bearer ${ownerToken}`).send({ otpRequestId: req1.body.otpRequestId, code: "333333" });
    const res = await request(app).post(`/api/invoices/${invoiceId}/download/verify-otp`).set("Authorization", `Bearer ${ownerToken}`).send({ otpRequestId: req1.body.otpRequestId, code: req1.body.demoOtp });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/attempts/);
  });

  it("a stranger cannot verify an OTP for this invoice even with a stolen otpRequestId (403 — ownership checked before OTP logic runs at all)", async () => {
    const req1 = await request(app).post(`/api/invoices/${invoiceId}/download/request-otp`).set("Authorization", `Bearer ${ownerToken}`).send({});
    const res = await request(app).post(`/api/invoices/${invoiceId}/download/verify-otp`).set("Authorization", `Bearer ${strangerToken}`).send({ otpRequestId: req1.body.otpRequestId, code: req1.body.demoOtp });
    expect(res.status).toBe(403);
  });
});
