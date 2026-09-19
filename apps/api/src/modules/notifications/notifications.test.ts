import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { buildApp } from "../../server.js";
import { loadConfig } from "../../config/config.js";
import { createLogger } from "../../shared/logger.js";

describe("Notifications — LOG-003 routing matrix, snapshot never rewritten by later rule changes", () => {
  const config = loadConfig();
  const pool = new pg.Pool({
    host: config.PGHOST, port: config.PGPORT, user: config.PGUSER,
    password: config.PGPASSWORD, database: config.PGDATABASE,
  });
  const app = buildApp(config, pool, createLogger(config));

  let orgId: string;
  let staffToken: string;
  let recipientId: string;

  beforeAll(async () => {
    const { rows } = await pool.query("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id", [`Notifications Test ${randomUUID()}`, `notifications-test-${randomUUID()}`]);
    orgId = rows[0].id;

    for (const key of ["notifications.manage", "notifications.send"]) {
      await pool.query("INSERT INTO permissions (key, description) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [key, key]);
    }
    const { rows: roleRows } = await pool.query("INSERT INTO roles (organization_id, name) VALUES ($1, 'Notifications Staff') RETURNING id", [orgId]);
    for (const key of ["notifications.manage", "notifications.send"]) {
      await pool.query("INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = $2", [roleRows[0].id, key]);
    }
    const staffEmail = `notif-staff-${randomUUID()}@example.com`;
    const staff = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "Notifications Staff", email: staffEmail, password: "pw123456" });
    await pool.query("INSERT INTO identity_roles (identity_id, role_id) VALUES ($1, $2)", [staff.body.id, roleRows[0].id]);
    staffToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: staffEmail, password: "pw123456" })).body.sessionToken;

    const recipEmail = `notif-recipient-${randomUUID()}@example.com`;
    const recipient = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "customer", displayName: "Notification Recipient", email: recipEmail, password: "pw123456" });
    recipientId = recipient.body.id;
  });

  afterAll(async () => { await pool.end(); });

  it("sending a notification uses the CURRENTLY active routing rule's channels", async () => {
    const type = await request(app).post("/api/notifications/types").set("Authorization", `Bearer ${staffToken}`).send({ key: `order.delivered.${randomUUID()}`, description: "Order delivered" });
    await request(app).put("/api/notifications/routing-rules").set("Authorization", `Bearer ${staffToken}`).send({ notificationTypeId: type.body.id, recipientRole: "customer", channel: "sms" });
    await request(app).put("/api/notifications/routing-rules").set("Authorization", `Bearer ${staffToken}`).send({ notificationTypeId: type.body.id, recipientRole: "customer", channel: "email" });

    const res = await request(app).post("/api/notifications/send").set("Authorization", `Bearer ${staffToken}`).send({ typeKey: type.body.key, recipientIdentityId: recipientId, recipientRole: "customer" });
    expect(res.status).toBe(201);
    expect(res.body.channels_snapshot.sort()).toEqual(["email", "sms"]);
  });

  it("sending with no routing rule configured is rejected (409), nothing silently sent", async () => {
    const type = await request(app).post("/api/notifications/types").set("Authorization", `Bearer ${staffToken}`).send({ key: `unrouted.${randomUUID()}`, description: "No rule for this one" });
    const res = await request(app).post("/api/notifications/send").set("Authorization", `Bearer ${staffToken}`).send({ typeKey: type.body.key, recipientIdentityId: recipientId, recipientRole: "customer" });
    expect(res.status).toBe(409);
  });

  it("CRITICAL (LOG-003) — changing a routing rule AFTER a notification was sent does NOT rewrite that notification's own history", async () => {
    const type = await request(app).post("/api/notifications/types").set("Authorization", `Bearer ${staffToken}`).send({ key: `complaint.resolved.${randomUUID()}`, description: "Complaint resolved" });
    await request(app).put("/api/notifications/routing-rules").set("Authorization", `Bearer ${staffToken}`).send({ notificationTypeId: type.body.id, recipientRole: "customer", channel: "sms" });
    await request(app).put("/api/notifications/routing-rules").set("Authorization", `Bearer ${staffToken}`).send({ notificationTypeId: type.body.id, recipientRole: "customer", channel: "email" });

    // Notification #1, sent while the rule is [sms, email].
    const first = await request(app).post("/api/notifications/send").set("Authorization", `Bearer ${staffToken}`).send({ typeKey: type.body.key, recipientIdentityId: recipientId, recipientRole: "customer" });
    expect(first.body.channels_snapshot.sort()).toEqual(["email", "sms"]);

    // Now change the rule: remove sms and email, add whatsapp only.
    await request(app).delete("/api/notifications/routing-rules").set("Authorization", `Bearer ${staffToken}`).send({ notificationTypeId: type.body.id, recipientRole: "customer", channel: "sms" });
    await request(app).delete("/api/notifications/routing-rules").set("Authorization", `Bearer ${staffToken}`).send({ notificationTypeId: type.body.id, recipientRole: "customer", channel: "email" });
    await request(app).put("/api/notifications/routing-rules").set("Authorization", `Bearer ${staffToken}`).send({ notificationTypeId: type.body.id, recipientRole: "customer", channel: "whatsapp" });

    // Notification #2, sent AFTER the rule change — reflects the NEW rule.
    const second = await request(app).post("/api/notifications/send").set("Authorization", `Bearer ${staffToken}`).send({ typeKey: type.body.key, recipientIdentityId: recipientId, recipientRole: "customer" });
    expect(second.body.channels_snapshot).toEqual(["whatsapp"]);

    // The whole point of this test: re-fetch notification #1 — it must
    // STILL show [email, sms], completely unaffected by the rule
    // change that happened after it was created.
    const refetchedFirst = await request(app).get(`/api/notifications/${first.body.id}`).set("Authorization", `Bearer ${staffToken}`);
    expect(refetchedFirst.body.channels_snapshot.sort()).toEqual(["email", "sms"]);
  });

  it("CRITICAL — notifications are genuinely immutable at the database level, not just by convention", async () => {
    const type = await request(app).post("/api/notifications/types").set("Authorization", `Bearer ${staffToken}`).send({ key: `immutable.${randomUUID()}`, description: "X" });
    await request(app).put("/api/notifications/routing-rules").set("Authorization", `Bearer ${staffToken}`).send({ notificationTypeId: type.body.id, recipientRole: "customer", channel: "email" });
    const notification = await request(app).post("/api/notifications/send").set("Authorization", `Bearer ${staffToken}`).send({ typeKey: type.body.key, recipientIdentityId: recipientId, recipientRole: "customer" });

    await expect(pool.query("UPDATE notifications SET channels_snapshot = '{sms}' WHERE id = $1", [notification.body.id])).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM notifications WHERE id = $1", [notification.body.id])).rejects.toThrow(/append-only/);
  });

  it("a recipient sees their own notifications via /notifications/me", async () => {
    const recipEmail = `notif-self-${randomUUID()}@example.com`;
    const recip = await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "customer", displayName: "Self Notification Test", email: recipEmail, password: "pw123456" });
    const recipToken = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email: recipEmail, password: "pw123456" })).body.sessionToken;

    const type = await request(app).post("/api/notifications/types").set("Authorization", `Bearer ${staffToken}`).send({ key: `self.test.${randomUUID()}`, description: "X" });
    await request(app).put("/api/notifications/routing-rules").set("Authorization", `Bearer ${staffToken}`).send({ notificationTypeId: type.body.id, recipientRole: "customer", channel: "email" });
    await request(app).post("/api/notifications/send").set("Authorization", `Bearer ${staffToken}`).send({ typeKey: type.body.key, recipientIdentityId: recip.body.id, recipientRole: "customer" });

    const mine = await request(app).get("/api/notifications/me").set("Authorization", `Bearer ${recipToken}`);
    expect(mine.body.length).toBeGreaterThanOrEqual(1);
    expect(mine.body[0].recipient_identity_id).toBe(recip.body.id);
  });

  it("a staff identity without notifications.send cannot send one (403)", async () => {
    const email = `notif-noperm-${randomUUID()}@example.com`;
    await request(app).post("/api/identities/register").send({ organizationId: orgId, identityType: "staff", displayName: "No Perm", email, password: "pw123456" });
    const token = (await request(app).post("/api/identities/login").send({ organizationId: orgId, email, password: "pw123456" })).body.sessionToken;
    const res = await request(app).post("/api/notifications/send").set("Authorization", `Bearer ${token}`).send({ typeKey: "anything", recipientIdentityId: recipientId, recipientRole: "customer" });
    expect(res.status).toBe(403);
  });
});
