import { Router } from "express";
import type pg from "pg";

// Phase 1 requirement: "staging health/readiness."
// /health = "is the process alive" (never touches the DB — must stay
// fast and dependency-free so an orchestrator can trust it under load).
// /ready = "can this instance actually serve traffic" — a real
// round-trip to Postgres via the app_health table planted by migration
// 0001. A liveness probe should never depend on a downstream system;
// a readiness probe should.
export function createHealthRouter(pool: pg.Pool): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  router.get("/ready", async (_req, res) => {
    try {
      const { rows } = await pool.query<{ status: string }>("SELECT status FROM app_health WHERE id = 1");
      if (rows.length === 0 || rows[0]!.status !== "ok") {
        return res.status(503).json({ status: "not_ready", reason: "app_health row missing or unexpected" });
      }
      res.status(200).json({ status: "ready", database: "connected" });
    } catch (err) {
      res.status(503).json({ status: "not_ready", reason: (err as Error).message });
    }
  });

  return router;
}
