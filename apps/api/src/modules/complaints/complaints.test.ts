import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../server.js";
import { loadConfig } from "../../config/config.js";
import { createLogger } from "../../shared/logger.js";

describe("Complaints — CMP-003 (Manager-only resolution), CMP-006 (replacement isolation), evidence, ledger reuse", () => {
  const config = loadConfig();
  const pool = new pg.Pool({
    host: config.PGHOST, port: config.PGPORT, user: config.PGUSER,
    password: config.PGPASSWORD, database: config.PGDATABASE,
  });
  const app = buildApp(config, pool, createLogger(config));

  let orgId: string;
  let staffToken: string;      // orders + complaints.read + complaints.manage — NOT complaints.resolve
  let managerToken: string;    // additionally complaints.resolve
  let ownerToken: string;      // the customer who owns the order
  let strangerToken: string;   // a different customer
  let orderId: string;
  const customerPhone = `9${randomUUID().replace(/\D/g, "").slice(0, 9)}`;

  beforeAll(async () => {
    const { rows } = await pool.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [`Complaints Test ${randomUUID()}`, `complaints-test-${randomUUID()}`]);
    orgId = rows[0].id;

    for (const key of ["orders.import", "orders.read", "orders.write", "complaints.read", "complaints.manage", "complaints.resolve"]) {
      await pool.query("INSERT INTO permissions (key, description) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [key, key]);
    }
    const { rows: staffRole } = await pool.query("INSERT INTO roles (organization_id, name) VALUES ($1, 'Complaints Staff') RETURNING id", [orgId]);
    for (const key of ["orders.import", "orders.read", "orders.write", "complaints.read", "complaints.manage"]) {
      await pool.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = $2", [staffRole[0].id, key]);
    }
    const { rows: mgrRole } = await pool.query("INSERT INTO roles (organization_id, name) VALUES ($1, 'Complaints Manager') RETURNING id", [orgId]);
    for (const key of ["orders.import", "orders.read", "orders.write", "complaints.read", "complaints.manage", "complaints.resolve"]) {
      await pool.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = $2", [mgrRole[0].id, key]);
    }

    const staffEmail = `cmp-staff-${randomUUID()}@example.com`;
    const staff = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "Complaints Staff", email: staffEmail, password: "pw123456" });
    await pool.query("INSERT INTO identity_roles (identity_id, role_id) VALUES ($1, $2)", [staff.body.id, staffRole[0].id]);
    staffToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: staffEmail, password: "pw123456" })).body.sessionToken;

    const mgrEmail = `cmp-mgr-${randomUUID()}@example.com`;
    const mgr = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "Complaints Manager", email: mgrEmail, password: "pw123456" });
    await pool.query("INSERT INTO identity_roles (identity_id, role_id) VALUES ($1, $2)", [mgr.body.id, mgrRole[0].id]);
    managerToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: mgrEmail, password: "pw123456" })).body.sessionToken;

    const order = await request(app).post("/api/orders/import").set("Authorization", `Bearer ${staffToken}`).send({
      idempotencyKey: randomUUID(), orgPrefix: "ANILYA", productName: "Complaint Test Product", customerName: "Complaint Owner Customer", customerPhone, artworkIntent: "blank", orderValue: 1000,
    });
    orderId = order.body.id;
    await request(app).post(`/api/orders/${orderId}/confirm`).set("Authorization", `Bearer ${staffToken}`).send({});
    await request(app).post(`/api/orders/${orderId}/start`).set("Authorization", `Bearer ${staffToken}`).send({});
    await request(app).post(`/api/orders/${orderId}/complete`).set("Authorization", `Bearer ${staffToken}`).send({});
    await request(app).post(`/api/orders/${orderId}/deliver`).set("Authorization", `Bearer ${staffToken}`).send({});

    const { rows: custRows } = await pool.query("SELECT id FROM identities WHERE phone = $1", [customerPhone]);
    const { hashPassword } = await import("../identity/password.js");
    const ownerEmail = `owner-${randomUUID()}@example.com`;
    await pool.query("UPDATE identities SET password_hash = $1, email = $2 WHERE id = $3", [await hashPassword("pw123456"), ownerEmail, custRows[0].id]);
    ownerToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: ownerEmail, password: "pw123456" })).body.sessionToken;

    const strangerEmail = `cmp-stranger-${randomUUID()}@example.com`;
    await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "customer", displayName: "Stranger Customer", email: strangerEmail, password: "pw123456" });
    strangerToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: strangerEmail, password: "pw123456" })).body.sessionToken;
  });

  afterAll(async () => { await pool.end(); });

  it("a customer can raise a ticket on their own order, with a REQUESTED resolution that is only a wish", async () => {
    const res = await request(app).post(`/api/orders/${orderId}/complaints`).set("Authorization", `Bearer ${ownerToken}`).send({
      category: "Colour Mismatch", description: "Colours look off compared to the approved proof", requestedResolution: "I want a full refund",
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("raised");
    expect(res.body.resolution_type).toBeNull(); // stating a wish never itself resolves anything
  });

  it("CMP-002 — the same order can have MULTIPLE independent tickets", async () => {
    await request(app).post(`/api/orders/${orderId}/complaints`).set("Authorization", `Bearer ${ownerToken}`).send({ category: "Late Delivery", description: "Arrived 3 days late" });
    await request(app).post(`/api/orders/${orderId}/complaints`).set("Authorization", `Bearer ${ownerToken}`).send({ category: "Damaged Packaging", description: "Box was crushed" });
    const list = await request(app).get(`/api/orders/${orderId}/complaints`).set("Authorization", `Bearer ${staffToken}`);
    expect(list.body.length).toBeGreaterThanOrEqual(3);
  });

  it("a different customer cannot raise a ticket against someone else's order (403)", async () => {
    const res = await request(app).post(`/api/orders/${orderId}/complaints`).set("Authorization", `Bearer ${strangerToken}`).send({ category: "X", description: "Y" });
    expect(res.status).toBe(403);
  });

  it("CMP-004/005 — adding evidence while status is 'evidence_required' moves the SAME ticket back to review, never a new ticket", async () => {
    const ticket = await request(app).post(`/api/orders/${orderId}/complaints`).set("Authorization", `Bearer ${ownerToken}`).send({ category: "Print Quality", description: "Blurry text" });
    await request(app).post(`/api/complaints/${ticket.body.id}/status`).set("Authorization", `Bearer ${staffToken}`).send({ status: "evidence_required" });

    const evidence = await request(app).post(`/api/complaints/${ticket.body.id}/evidence`).set("Authorization", `Bearer ${ownerToken}`).send({ fileReference: "photo1.jpg" });
    expect(evidence.status).toBe(201);

    const after = await request(app).get(`/api/complaints/${ticket.body.id}`).set("Authorization", `Bearer ${staffToken}`);
    expect(after.body.id).toBe(ticket.body.id); // still the SAME ticket id
    expect(after.body.status).toBe("under_review"); // auto-advanced out of evidence_required
  });

  it("a different customer cannot attach evidence to someone else's ticket (403)", async () => {
    const ticket = await request(app).post(`/api/orders/${orderId}/complaints`).set("Authorization", `Bearer ${ownerToken}`).send({ category: "Z", description: "Z" });
    const res = await request(app).post(`/api/complaints/${ticket.body.id}/evidence`).set("Authorization", `Bearer ${strangerToken}`).send({ fileReference: "not-mine.jpg" });
    expect(res.status).toBe(403);
  });

  it("CRITICAL (CMP-003) — ordinary staff (complaints.manage but NOT complaints.resolve) cannot resolve a ticket (403)", async () => {
    const ticket = await request(app).post(`/api/orders/${orderId}/complaints`).set("Authorization", `Bearer ${ownerToken}`).send({ category: "RBAC Test", description: "X", requestedResolution: "Refund please" });
    const res = await request(app).post(`/api/complaints/${ticket.body.id}/resolve`).set("Authorization", `Bearer ${staffToken}`).send({ resolutionType: "refund", refundAmount: 100 });
    expect(res.status).toBe(403);
  });

  it("CRITICAL (CMP-003) — a refund resolution requires refundAmount (409 without it), and reuses the EXISTING Customer Ledger", async () => {
    const ticket = await request(app).post(`/api/orders/${orderId}/complaints`).set("Authorization", `Bearer ${ownerToken}`).send({ category: "Refund Test", description: "X" });

    const missingAmount = await request(app).post(`/api/complaints/${ticket.body.id}/resolve`).set("Authorization", `Bearer ${managerToken}`).send({ resolutionType: "refund" });
    expect(missingAmount.status).toBe(409);

    const before = await pool.query("SELECT final_balance FROM customer_ledger WHERE customer_identity_id = (SELECT customer_identity_id FROM orders WHERE id = $1) ORDER BY id DESC LIMIT 1", [orderId]);
    const startBalance = before.rows[0] ? Number(before.rows[0].final_balance) : 0;

    const resolve = await request(app).post(`/api/complaints/${ticket.body.id}/resolve`).set("Authorization", `Bearer ${managerToken}`).send({ resolutionType: "refund", refundAmount: 250, resolutionNotes: "Approved refund" });
    expect(resolve.status).toBe(200);
    expect(resolve.body.status).toBe("resolved");
    expect(resolve.body.resolution_type).toBe("refund");

    const after = await pool.query("SELECT final_balance FROM customer_ledger WHERE customer_identity_id = (SELECT customer_identity_id FROM orders WHERE id = $1) ORDER BY id DESC LIMIT 1", [orderId]);
    expect(Number(after.rows[0].final_balance)).toBe(startBalance - 250); // reduced by exactly the refund — the SAME ledger, not a parallel one
  });

  it("CRITICAL (CMP-006) — a replacement resolution creates a NEW order, and the ORIGINAL order's own stage is completely untouched", async () => {
    const ticket = await request(app).post(`/api/orders/${orderId}/complaints`).set("Authorization", `Bearer ${ownerToken}`).send({ category: "Replacement Test", description: "X" });
    const beforeOrder = await request(app).get(`/api/orders/${orderId}`).set("Authorization", `Bearer ${staffToken}`);
    expect(beforeOrder.body.stage).toBe("delivered");

    const resolve = await request(app).post(`/api/complaints/${ticket.body.id}/resolve`).set("Authorization", `Bearer ${managerToken}`).send({ resolutionType: "replacement", orgPrefix: "ANILYA", resolutionNotes: "Reprinting" });
    expect(resolve.status).toBe(200);
    expect(resolve.body.replacement_order_id).toBeTruthy();
    expect(resolve.body.replacement_order_id).not.toBe(orderId);

    const afterOriginal = await request(app).get(`/api/orders/${orderId}`).set("Authorization", `Bearer ${staffToken}`);
    expect(afterOriginal.body.stage).toBe("delivered"); // completely unchanged

    const replacement = await request(app).get(`/api/orders/${resolve.body.replacement_order_id}`).set("Authorization", `Bearer ${staffToken}`);
    expect(replacement.status).toBe(200);
    expect(replacement.body.stage).toBe("imported"); // a genuinely fresh order, its own independent lifecycle
  });

  it("resolving an already-resolved ticket a second time is rejected (409)", async () => {
    const ticket = await request(app).post(`/api/orders/${orderId}/complaints`).set("Authorization", `Bearer ${ownerToken}`).send({ category: "Double Resolve Test", description: "X" });
    await request(app).post(`/api/complaints/${ticket.body.id}/resolve`).set("Authorization", `Bearer ${managerToken}`).send({ resolutionType: "rejected", resolutionNotes: "Not valid" });
    const res = await request(app).post(`/api/complaints/${ticket.body.id}/resolve`).set("Authorization", `Bearer ${managerToken}`).send({ resolutionType: "rejected" });
    expect(res.status).toBe(409);
  });

  it("CMP-007 — a resolution is captured in the SAME unified audit_log used since Phase 2, not a parallel table", async () => {
    const ticket = await request(app).post(`/api/orders/${orderId}/complaints`).set("Authorization", `Bearer ${ownerToken}`).send({ category: "Audit Test", description: "X" });
    await request(app).post(`/api/complaints/${ticket.body.id}/resolve`).set("Authorization", `Bearer ${managerToken}`).send({ resolutionType: "credit", refundAmount: 50 });

    const { rows } = await pool.query("SELECT action_type, new_value FROM audit_log WHERE entity_id = $1 AND action_type = 'complaint.resolved'", [ticket.body.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].new_value).toBe("credit");
  });
});
