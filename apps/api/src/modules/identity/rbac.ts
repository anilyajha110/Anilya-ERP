import type { NextFunction, Request, Response } from "express";
import type pg from "pg";
import { verifySession } from "./session.service.js";
import { findIdentityById, type Identity } from "./identity.service.js";

declare global {
  namespace Express {
    interface Request {
      identity?: Identity;
      sessionId?: string;
    }
  }
}

// Attaches req.identity from the Bearer session token — and ONLY from
// there. This is the direct fix for RISK-003 (Phase 0 audit): the
// prototype had ~50 endpoints that read `actorRole` out of the request
// BODY and trusted it for audit attribution, with the boundary to
// actual authorization easy to blur. Nothing past this middleware may
// read a role/identity from anywhere except req.identity.
export function requireAuth(pool: pg.Pool) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "missing_bearer_token" });

    const verified = await verifySession(pool, token);
    if (!verified) return res.status(401).json({ error: "invalid_or_expired_session" });

    const identity = await findIdentityById(pool, verified.identityId);
    if (!identity) return res.status(401).json({ error: "identity_not_found_or_inactive" });

    req.identity = identity;
    req.sessionId = verified.session.id;
    next();
  };
}

// Checks the AUTHENTICATED identity's roles/permissions against the
// database — never a client-supplied claim. Must run after requireAuth.
export function requirePermission(pool: pg.Pool, permissionKey: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.identity) return res.status(401).json({ error: "not_authenticated" });

    const { rows } = await pool.query<{ has_permission: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM identity_roles ir
         JOIN role_permissions rp ON rp.role_id = ir.role_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE ir.identity_id = $1 AND p.key = $2
       ) AS has_permission`,
      [req.identity.id, permissionKey]
    );

    if (!rows[0]?.has_permission) {
      return res.status(403).json({ error: "forbidden", requiredPermission: permissionKey });
    }
    next();
  };
}
