import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../server.js";
import { loadConfig } from "../../config/config.js";
import { createLogger } from "../../shared/logger.js";

describe("Vendor Rates — JOB-005 auto-accept, JOB-006 master rate never silently moves", () => {
  const config = loadConfig();
  const pool = new pg.Pool({
    host: config.PGHOST, port: config.PGPORT, user: config.PGUSER,
    password: config.PGPASSWORD, database: config.PGDATABASE,
  });
  const app = buildApp(config, pool, createLogger(config));

  let orgId: string;
  let staffToken: string;    // orders/jobs + vendorrates.quote.submit — NOT approve or master.manage
  let managerToken: string;  // additionally vendorrates.quote.approve AND vendorrates.master.manage
  let orderId: string;
  const category = `lamination-${randomUUID()}`;

  beforeAll(async () => {
    const { rows } = await pool.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [`Vendor Rate Test ${randomUUID()}`, `vendor-rate-test-${randomUUID()}`]);
    orgId = rows[0].id;

    for (const key of ["orders.import", "orders.write", "jobs.manage", "vendorrates.read", "vendorrates.quote.submit", "vendorrates.quote.approve", "vendorrates.master.manage"]) {
      await pool.query("INSERT INTO permissions (key, description) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [key, key]);
    }
    const { rows: staffRole } = await pool.query("INSERT INTO roles (organization_id, name) VALUES ($1, 'Vendor Rate Staff') RETURNING id", [orgId]);
    for (const key of ["orders.import", "orders.write", "jobs.manage", "vendorrates.read", "vendorrates.quote.submit"]) {
      await pool.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = $2", [staffRole[0].id, key]);
    }
    const { rows: mgrRole } = await pool.query("INSERT INTO roles (organization_id, name) VALUES ($1, 'Vendor Rate Manager') RETURNING id", [orgId]);
    for (const key of ["orders.import", "orders.write", "jobs.manage", "vendorrates.read", "vendorrates.quote.submit", "vendorrates.quote.approve", "vendorrates.master.manage"]) {
      await pool.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = $2", [mgrRole[0].id, key]);
    }

    const staffEmail = `vr-staff-${randomUUID()}@example.com`;
    const staff = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "VR Staff", email: staffEmail, password: "pw123456" });
    await pool.query("INSERT INTO identity_roles (identity_id, role_id) VALUES ($1, $2)", [staff.body.id, staffRole[0].id]);
    staffToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: staffEmail, password: "pw123456" })).body.sessionToken;

    const mgrEmail = `vr-mgr-${randomUUID()}@example.com`;
    const mgr = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "VR Manager", email: mgrEmail, password: "pw123456" });
    await pool.query("INSERT INTO identity_roles (identity_id, role_id) VALUES ($1, $2)", [mgr.body.id, mgrRole[0].id]);
    managerToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: mgrEmail, password: "pw123456" })).body.sessionToken;

    const order = await request(app).post("/api/orders/import").set("Authorization", `Bearer ${staffToken}`).send({
      idempotencyKey: randomUUID(), orgPrefix: "ANILYA", productName: "Vendor Rate Test Product", customerName: `VR Customer ${randomUUID()}`, artworkIntent: "blank",
    });
    orderId = order.body.id;

    await request(app).put(`/api/vendor-rates/${category}`).set("Authorization", `Bearer ${managerToken}`).send({ referenceRate: 100 });
  });

  afterAll(async () => { await pool.end(); });

  async function createJob(description: string) {
    const job = await request(app).post(`/api/orders/${orderId}/jobs`).set("Authorization", `Bearer ${staffToken}`).send({ jobType: "extra", description });
    return job.body.id;
  }

  it("a quote AT the reference rate is auto-accepted, no Manager involved", async () => {
    const jobId = await createJob("Auto-accept exact match");
    const res = await request(app).post("/api/vendor-rates/quotes").set("Authorization", `Bearer ${staffToken}`).send({ jobId, quotedRate: 100, category });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("auto_accepted");
  });

  it("a quote UNDER the reference rate is auto-accepted", async () => {
    const jobId = await createJob("Auto-accept under");
    const res = await request(app).post("/api/vendor-rates/quotes").set("Authorization", `Bearer ${staffToken}`).send({ jobId, quotedRate: 80, category });
    expect(res.body.status).toBe("auto_accepted");
  });

  it("a quote OVER the reference rate requires Manager approval, not auto-accepted", async () => {
    const jobId = await createJob("Needs approval");
    const res = await request(app).post("/api/vendor-rates/quotes").set("Authorization", `Bearer ${staffToken}`).send({ jobId, quotedRate: 150, category });
    expect(res.body.status).toBe("pending_approval");
  });

  it("CRITICAL (JOB-006) — approving a high quote does NOT move the master reference rate", async () => {
    const before = await request(app).get(`/api/vendor-rates/${category}`).set("Authorization", `Bearer ${staffToken}`);
    expect(Number(before.body.reference_rate)).toBe(100);

    const jobId = await createJob("High quote, approved");
    const quote = await request(app).post("/api/vendor-rates/quotes").set("Authorization", `Bearer ${staffToken}`).send({ jobId, quotedRate: 500, category });
    const approve = await request(app).post(`/api/vendor-rates/quotes/${quote.body.id}/approve`).set("Authorization", `Bearer ${managerToken}`).send({});
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe("approved");

    // The whole point of the test: even after approving a quote 5x the
    // reference rate, the master rate itself is untouched.
    const after = await request(app).get(`/api/vendor-rates/${category}`).set("Authorization", `Bearer ${staffToken}`);
    expect(Number(after.body.reference_rate)).toBe(100);
  });

  it("a later master-rate change never retroactively alters an already-decided quote's own record", async () => {
    const jobId = await createJob("Snapshot test");
    const quote = await request(app).post("/api/vendor-rates/quotes").set("Authorization", `Bearer ${staffToken}`).send({ jobId, quotedRate: 90, category });
    expect(quote.body.status).toBe("auto_accepted");
    expect(Number(quote.body.reference_rate_at_quote)).toBe(100);

    await request(app).put(`/api/vendor-rates/${category}`).set("Authorization", `Bearer ${managerToken}`).send({ referenceRate: 50 }); // now 90 would be ABOVE the new rate

    const { rows } = await pool.query("SELECT reference_rate_at_quote, status FROM vendor_rate_quotes WHERE id = $1", [quote.body.id]);
    expect(Number(rows[0].reference_rate_at_quote)).toBe(100); // unchanged — history, not live-recomputed
    expect(rows[0].status).toBe("auto_accepted");

    await request(app).put(`/api/vendor-rates/${category}`).set("Authorization", `Bearer ${managerToken}`).send({ referenceRate: 100 }); // restore for other tests
  });

  it("approving an already-decided quote a second time is rejected (409)", async () => {
    const jobId = await createJob("Double approve");
    const quote = await request(app).post("/api/vendor-rates/quotes").set("Authorization", `Bearer ${staffToken}`).send({ jobId, quotedRate: 200, category });
    await request(app).post(`/api/vendor-rates/quotes/${quote.body.id}/approve`).set("Authorization", `Bearer ${managerToken}`).send({});
    const res = await request(app).post(`/api/vendor-rates/quotes/${quote.body.id}/approve`).set("Authorization", `Bearer ${managerToken}`).send({});
    expect(res.status).toBe(409);
  });

  it("CRITICAL RBAC — ordinary staff (can submit quotes, but not vendorrates.quote.approve) cannot approve one (403)", async () => {
    const jobId = await createJob("RBAC test");
    const quote = await request(app).post("/api/vendor-rates/quotes").set("Authorization", `Bearer ${staffToken}`).send({ jobId, quotedRate: 300, category });
    const res = await request(app).post(`/api/vendor-rates/quotes/${quote.body.id}/approve`).set("Authorization", `Bearer ${staffToken}`).send({});
    expect(res.status).toBe(403);
  });

  it("CRITICAL RBAC — ordinary staff cannot set the master rate (403) — vendorrates.master.manage is its own separate permission", async () => {
    const res = await request(app).put(`/api/vendor-rates/${category}`).set("Authorization", `Bearer ${staffToken}`).send({ referenceRate: 999 });
    expect(res.status).toBe(403);
  });
});

describe("Operator Ledger — JOB-007, no rate math, idempotent payable replay", () => {
  const config = loadConfig();
  const pool = new pg.Pool({
    host: config.PGHOST, port: config.PGPORT, user: config.PGUSER,
    password: config.PGPASSWORD, database: config.PGDATABASE,
  });
  const app = buildApp(config, pool, createLogger(config));

  let orgId: string;
  let staffToken: string;
  let operatorId: string;

  beforeAll(async () => {
    const { rows } = await pool.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [`Operator Ledger Test ${randomUUID()}`, `operator-ledger-test-${randomUUID()}`]);
    orgId = rows[0].id;

    for (const key of ["operatorledger.write", "operatorledger.read"]) {
      await pool.query("INSERT INTO permissions (key, description) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [key, key]);
    }
    const { rows: roleRows } = await pool.query("INSERT INTO roles (organization_id, name) VALUES ($1, 'Operator Ledger Staff') RETURNING id", [orgId]);
    for (const key of ["operatorledger.write", "operatorledger.read"]) {
      await pool.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = $2", [roleRows[0].id, key]);
    }
    const staffEmail = `ol-staff-${randomUUID()}@example.com`;
    const staff = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "OL Staff", email: staffEmail, password: "pw123456" });
    await pool.query("INSERT INTO identity_roles (identity_id, role_id) VALUES ($1, $2)", [staff.body.id, roleRows[0].id]);
    staffToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: staffEmail, password: "pw123456" })).body.sessionToken;

    const opEmail = `operator-${randomUUID()}@example.com`;
    const operator = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "partner", displayName: "Test Operator", email: opEmail, password: "pw123456" });
    operatorId = operator.body.id;
  });

  afterAll(async () => { await pool.end(); });

  it("recording a payable increases the running balance correctly", async () => {
    const res = await request(app).post(`/api/operators/${operatorId}/ledger/payable`).set("Authorization", `Bearer ${staffToken}`).send({ amount: 500, externalReference: `WORK-${randomUUID()}` });
    expect(res.status).toBe(201);
    expect(Number(res.body.final_balance)).toBe(500);
  });

  it("recording a payment decreases the running balance correctly", async () => {
    const before = await request(app).get(`/api/operators/${operatorId}/ledger`).set("Authorization", `Bearer ${staffToken}`);
    const startBalance = before.body.currentBalance;

    const res = await request(app).post(`/api/operators/${operatorId}/ledger/payment`).set("Authorization", `Bearer ${staffToken}`).send({ amount: 200 });
    expect(res.status).toBe(201);
    expect(Number(res.body.final_balance)).toBe(Number(startBalance) - 200);
  });

  it("CRITICAL (JOB-007) — replaying the exact same WORK_ID (externalReference) is a safe no-op, never a double-credit", async () => {
    const workId = `WORK-${randomUUID()}`;
    const before = await request(app).get(`/api/operators/${operatorId}/ledger`).set("Authorization", `Bearer ${staffToken}`);
    const startBalance = Number(before.body.currentBalance);

    const first = await request(app).post(`/api/operators/${operatorId}/ledger/payable`).set("Authorization", `Bearer ${staffToken}`).send({ amount: 300, externalReference: workId });
    const second = await request(app).post(`/api/operators/${operatorId}/ledger/payable`).set("Authorization", `Bearer ${staffToken}`).send({ amount: 300, externalReference: workId });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200); // not 201 — nothing new was created
    expect(second.body.wasNew).toBe(false);
    expect(second.body.id).toBe(first.body.id);

    const after = await request(app).get(`/api/operators/${operatorId}/ledger`).set("Authorization", `Bearer ${staffToken}`);
    expect(Number(after.body.currentBalance)).toBe(startBalance + 300); // credited exactly ONCE, not twice
  });

  it("CRITICAL — operator_ledger is genuinely immutable at the database level, not just by convention", async () => {
    const { rows } = await pool.query("SELECT id FROM operator_ledger WHERE operator_identity_id = $1 LIMIT 1", [operatorId]);
    await expect(pool.query("UPDATE operator_ledger SET amount = 99999 WHERE id = $1", [rows[0].id])).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM operator_ledger WHERE id = $1", [rows[0].id])).rejects.toThrow(/append-only/);
  });

  it("a staff identity without operatorledger.write cannot record a payable (403)", async () => {
    const email = `ol-noperm-${randomUUID()}@example.com`;
    await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "No Perm", email, password: "pw123456" });
    const token = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email, password: "pw123456" })).body.sessionToken;
    const res = await request(app).post(`/api/operators/${operatorId}/ledger/payable`).set("Authorization", `Bearer ${token}`).send({ amount: 100, externalReference: `WORK-${randomUUID()}` });
    expect(res.status).toBe(403);
  });
});
