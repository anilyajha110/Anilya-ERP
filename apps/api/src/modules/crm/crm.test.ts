import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../server.js";
import { loadConfig } from "../../config/config.js";
import { createLogger } from "../../shared/logger.js";

describe("CRM — customer find-or-create, ledger, import, self-service", () => {
  const config = loadConfig();
  const pool = new pg.Pool({
    host: config.PGHOST, port: config.PGPORT, user: config.PGUSER,
    password: config.PGPASSWORD, database: config.PGDATABASE,
  });
  const app = buildApp(config, pool, createLogger(config));

  let orgId: string;
  let staffToken: string;

  beforeAll(async () => {
    const { rows: orgRows } = await pool.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [`CRM Test ${randomUUID()}`, `crm-test-${randomUUID()}`]);
    orgId = orgRows[0].id;

    // Grant every CRM permission to one role, one staff identity — the
    // permission catalog itself is a Phase 2 concept; Phase 3 just uses it.
    const perms = ["customers.write", "customers.read", "customers.import", "customers.ledger.adjust"];
    const { rows: roleRows } = await pool.query("INSERT INTO roles (organization_id, name) VALUES ($1, 'CRM Staff') RETURNING id", [orgId]);
    for (const key of perms) {
      const { rows: p } = await pool.query("INSERT INTO permissions (key, description) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description RETURNING id", [key, key]);
      await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)", [roleRows[0].id, p[0].id]);
    }

    const staffEmail = `staff-${randomUUID()}@example.com`;
    const staff = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "CRM Staff Member", email: staffEmail, password: "pw123456" });
    await pool.query("INSERT INTO identity_roles (identity_id, role_id) VALUES ($1, $2)", [staff.body.id, roleRows[0].id]);
    staffToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: staffEmail, password: "pw123456" })).body.sessionToken;
  });

  afterAll(async () => { await pool.end(); });

  it("creates a new customer when nothing matches", async () => {
    const res = await request(app).post("/api/customers").set("Authorization", `Bearer ${staffToken}`).send({ displayName: "Ramesh Kumar", phone: "9876500001" });
    expect(res.status).toBe(201);
    expect(res.body.wasNew).toBe(true);
    expect(res.body.status).toBe("active"); // has a phone, so not a bare placeholder
  });

  it("finds the SAME customer again by phone, does not create a duplicate", async () => {
    const res = await request(app).post("/api/customers").set("Authorization", `Bearer ${staffToken}`).send({ displayName: "Ramesh K.", phone: "9876500001" });
    expect(res.status).toBe(200);
    expect(res.body.wasNew).toBe(false);
  });

  it("phone takes priority over email when both could theoretically differ", async () => {
    // Same phone as above, but a completely different email this time —
    // must still resolve to the SAME existing customer (phone wins).
    const res = await request(app).post("/api/customers").set("Authorization", `Bearer ${staffToken}`).send({ displayName: "Ramesh", phone: "9876500001", email: "totally-different@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.wasNew).toBe(false);
  });

  it("a customer with no phone or email is created as 'dummy'", async () => {
    const res = await request(app).post("/api/customers").set("Authorization", `Bearer ${staffToken}`).send({ displayName: "Walk-in Customer" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("dummy");
  });

  it("posts a job value to the ledger and computes the correct running balance", async () => {
    const customer = (await request(app).post("/api/customers").set("Authorization", `Bearer ${staffToken}`).send({ displayName: "Ledger Test Customer", phone: `98${Date.now()}`.slice(0, 10) })).body;

    const adj1 = await request(app).post(`/api/customers/${customer.identity_id}/ledger/adjustment`).set("Authorization", `Bearer ${staffToken}`).send({ amount: 500, remarks: "opening balance" });
    expect(adj1.body.final_balance).toBe("500.00");

    const adj2 = await request(app).post(`/api/customers/${customer.identity_id}/ledger/adjustment`).set("Authorization", `Bearer ${staffToken}`).send({ amount: -200, remarks: "partial payment recorded as adjustment" });
    expect(adj2.body.previous_balance).toBe("500.00");
    expect(adj2.body.final_balance).toBe("300.00");

    const ledger = await request(app).get(`/api/customers/${customer.identity_id}/ledger`).set("Authorization", `Bearer ${staffToken}`);
    expect(ledger.body.currentBalance).toBe(300);
    expect(ledger.body.entries).toHaveLength(2);
  });

  it("IMPORT PREVIEW writes nothing — a duplicate preview of the same rows shows identical results", async () => {
    const rows = [{ name: "Preview Test 1", phone: `97${Date.now()}`.slice(0, 10) }];
    const preview1 = await request(app).post("/api/customers/import/preview").set("Authorization", `Bearer ${staffToken}`).send({ rows });
    const preview2 = await request(app).post("/api/customers/import/preview").set("Authorization", `Bearer ${staffToken}`).send({ rows });
    expect(preview1.body.willCreate).toBe(1);
    expect(preview2.body.willCreate).toBe(1); // still "new" both times — preview never actually created it
  });

  it("IMPORT COMMIT creates new customers and correctly matches existing ones in the same batch", async () => {
    const existingPhone = `96${Date.now()}`.slice(0, 10);
    await request(app).post("/api/customers").set("Authorization", `Bearer ${staffToken}`).send({ displayName: "Pre-existing", phone: existingPhone });

    const rows = [
      { name: "Brand New Customer", phone: `95${Date.now()}`.slice(0, 10) },
      { name: "Pre-existing Again", phone: existingPhone },
    ];
    const res = await request(app).post("/api/customers/import/commit").set("Authorization", `Bearer ${staffToken}`).send({ rows });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(1);
    expect(res.body.matched).toBe(1);
  });

  it("ROLLBACK removes only the customer THIS batch created — a pre-existing matched customer survives untouched", async () => {
    const preexistingPhone = `94${Date.now()}`.slice(0, 10);
    const preexisting = (await request(app).post("/api/customers").set("Authorization", `Bearer ${staffToken}`).send({ displayName: "Must Survive Rollback", phone: preexistingPhone })).body;

    const newPhone = `93${Date.now()}`.slice(0, 10);
    const commit = await request(app).post("/api/customers/import/commit").set("Authorization", `Bearer ${staffToken}`).send({
      rows: [{ name: "Should Be Deleted By Rollback", phone: newPhone }, { name: "Matched, must survive", phone: preexistingPhone }],
    });

    const rollback = await request(app).post(`/api/customers/import/${commit.body.batchId}/rollback`).set("Authorization", `Bearer ${staffToken}`);
    expect(rollback.status).toBe(200);
    expect(rollback.body.deletedCustomers).toBe(1); // only the genuinely new one

    // The pre-existing customer must still be there, completely intact.
    const stillThere = await request(app).get(`/api/customers/${preexisting.identity_id}`).set("Authorization", `Bearer ${staffToken}`);
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.display_name).toBe("Must Survive Rollback");
  });

  it("rolling back the SAME batch twice is rejected (409), not silently repeated", async () => {
    const rows = [{ name: "Single Use Batch", phone: `92${Date.now()}`.slice(0, 10) }];
    const commit = await request(app).post("/api/customers/import/commit").set("Authorization", `Bearer ${staffToken}`).send({ rows });
    await request(app).post(`/api/customers/import/${commit.body.batchId}/rollback`).set("Authorization", `Bearer ${staffToken}`);
    const second = await request(app).post(`/api/customers/import/${commit.body.batchId}/rollback`).set("Authorization", `Bearer ${staffToken}`);
    expect(second.status).toBe(409);
  });

  it("a staff identity WITHOUT customers.write cannot create a customer (403)", async () => {
    const noPermEmail = `noperm-${randomUUID()}@example.com`;
    await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "No Permissions", email: noPermEmail, password: "pw123456" });
    const noPermToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: noPermEmail, password: "pw123456" })).body.sessionToken;
    const res = await request(app).post("/api/customers").set("Authorization", `Bearer ${noPermToken}`).send({ displayName: "Should Fail" });
    expect(res.status).toBe(403);
  });
});

describe("CRM self-service — a customer can only ever see their OWN data", () => {
  const config = loadConfig();
  const pool = new pg.Pool({
    host: config.PGHOST, port: config.PGPORT, user: config.PGUSER,
    password: config.PGPASSWORD, database: config.PGDATABASE,
  });
  const app = buildApp(config, pool, createLogger(config));
  let orgId: string;

  beforeAll(async () => {
    const { rows } = await pool.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [`Self-Service Test ${randomUUID()}`, `selfsvc-${randomUUID()}`]);
    orgId = rows[0].id;
  });
  afterAll(async () => { await pool.end(); });

  it("a logged-in customer sees exactly their own profile via /me — never another customer's, and never needs to supply an id", async () => {
    const emailA = `customer-a-${randomUUID()}@example.com`;
    const emailB = `customer-b-${randomUUID()}@example.com`;
    await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "customer", displayName: "Customer A", email: emailA, password: "pw123456" });
    await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "customer", displayName: "Customer B", email: emailB, password: "pw123456" });

    const tokenA = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: emailA, password: "pw123456" })).body.sessionToken;

    const me = await request(app).get("/api/customers/me").set("Authorization", `Bearer ${tokenA}`);
    expect(me.status).toBe(200);
    expect(me.body.display_name).toBe("Customer A"); // never "Customer B" — there is no id in this URL to manipulate
  });

  it("a staff identity (not a customer) is rejected from the customer self-service route (403)", async () => {
    const staffEmail = `not-a-customer-${randomUUID()}@example.com`;
    await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "Staff, Not Customer", email: staffEmail, password: "pw123456" });
    const staffToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: staffEmail, password: "pw123456" })).body.sessionToken;

    const res = await request(app).get("/api/customers/me").set("Authorization", `Bearer ${staffToken}`);
    expect(res.status).toBe(403);
  });
});
