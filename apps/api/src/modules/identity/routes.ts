import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { registerIdentity, findIdentityByEmail, DuplicateIdentityError } from "./identity.service.js";
import { verifyPassword } from "./password.js";
import { createSession, revokeSession } from "./session.service.js";
import { requireAuth } from "./rbac.js";
import { logActivity } from "./audit.service.js";

function getIp(req: Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}

export function createIdentityRouter(pool: pg.Pool): Router {
  const router = Router();

  router.post("/identities/register", async (req: Request, res: Response) => {
    const { organizationId, identityType, displayName, email, phone, password } = req.body ?? {};
    if (!organizationId || !identityType || !displayName) {
      return res.status(400).json({ error: "organizationId, identityType, and displayName are required" });
    }
    try {
      const identity = await registerIdentity(pool, { organizationId, identityType, displayName, email, phone, password });
      await logActivity(pool, {
        organizationId, actorIdentityId: identity.id, actionType: "identity.registered",
        entityType: "identity", entityId: identity.id, ipAddress: getIp(req),
        remarks: `${displayName} registered as ${identityType}`,
      });
      res.status(201).json({ id: identity.id, displayName: identity.display_name, identityType: identity.identity_type });
    } catch (err) {
      if (err instanceof DuplicateIdentityError) return res.status(409).json({ error: err.message });
      throw err;
    }
  });

  router.post("/identities/login", async (req: Request, res: Response) => {
    const { organizationId, email, password } = req.body ?? {};
    if (!organizationId || !email || !password) {
      return res.status(400).json({ error: "organizationId, email, and password are required" });
    }

    const identity = await findIdentityByEmail(pool, organizationId, email);
    // Deliberately identical error for "no such identity" and "wrong
    // password" — a different message would let a caller enumerate
    // which emails are registered.
    if (!identity || !identity.password_hash || !(await verifyPassword(password, identity.password_hash))) {
      return res.status(401).json({ error: "invalid_credentials" });
    }

    const { rawToken, session } = await createSession(pool, {
      identityId: identity.id, loginMethod: "password", ipAddress: getIp(req), deviceInfo: req.headers["user-agent"],
    });
    await logActivity(pool, {
      organizationId, actorIdentityId: identity.id, actionType: "identity.login",
      entityType: "session", entityId: session.id, ipAddress: getIp(req), sessionId: session.id,
      remarks: `${identity.display_name} logged in (password)`,
    });

    res.json({ sessionToken: rawToken, expiresAt: session.expires_at, identity: { id: identity.id, displayName: identity.display_name, identityType: identity.identity_type } });
  });

  router.post("/identities/logout", requireAuth(pool), async (req: Request, res: Response) => {
    const header = req.header("authorization")!;
    const token = header.slice(7);
    await revokeSession(pool, token);
    await logActivity(pool, {
      organizationId: req.identity!.organization_id, actorIdentityId: req.identity!.id, actionType: "identity.logout",
      entityType: "session", entityId: req.sessionId, ipAddress: getIp(req), sessionId: req.sessionId,
      remarks: `${req.identity!.display_name} logged out`,
    });
    res.json({ loggedOut: true });
  });

  // Proves requireAuth works end-to-end: returns exactly who the
  // SERVER believes is making this request, derived only from the
  // verified session — never from anything the client claims.
  router.get("/identities/me", requireAuth(pool), (req: Request, res: Response) => {
    res.json({ id: req.identity!.id, displayName: req.identity!.display_name, identityType: req.identity!.identity_type });
  });

  return router;
}
