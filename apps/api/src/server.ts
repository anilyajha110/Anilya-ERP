import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { pinoHttp } from "pino-http";
import pg from "pg";
import { pathToFileURL } from "node:url";
import { loadConfig, type Config } from "./config/config.js";
import { createLogger, type Logger } from "./shared/logger.js";
import { correlationIdMiddleware } from "./shared/correlation-id.js";
import { createHealthRouter } from "./shared/health.js";
import { createIdentityRouter } from "./modules/identity/routes.js";
import { createCrmRouter } from "./modules/crm/routes.js";
import { ensureCustomerProfile } from "./modules/crm/customer.service.js";
import { createOrdersRouter, createPublicTrackingRouter } from "./modules/orders/routes.js";
import { createArtworkRouter } from "./modules/artwork/routes.js";

// Exported as a factory (not "start the server as a side effect of
// importing this file") specifically so tests can build a real app
// instance, against a real (test) database, without binding a port —
// this is what makes apps/api/src/server.test.ts a genuine integration
// test rather than a mock.
export function buildApp(config: Config, pool: pg.Pool, logger: Logger): Express {
  const app = express();
  app.use(correlationIdMiddleware);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as Request).correlationId,
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
    })
  );
  app.use(express.json({ limit: "1mb" }));

  app.use(createHealthRouter(pool));
  app.use("/api", createIdentityRouter(pool, {
    onIdentityCreated: async (identity) => {
      if (identity.identityType === "customer") await ensureCustomerProfile(pool, identity.id);
    },
  }));
  app.use("/api", createCrmRouter(pool));
  app.use("/api", createOrdersRouter(pool));
  app.use("/api", createArtworkRouter(pool));
  app.use(createPublicTrackingRouter(pool)); // deliberately NOT under /api or requireAuth — public tracking links

  // Structured error handler — every unhandled error becomes a
  // consistent JSON shape carrying the correlation id, never a stack
  // trace leaked to the client (Phase 1 "structured errors").
  app.use((err: Error, req: Request, res: Response, _next: NextFunction): void => {
    req.log.error({ err }, "Unhandled error");
    res.status(500).json({
      error: "internal_server_error",
      correlationId: req.correlationId,
    });
  });

  return app;
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config);
  const pool = new pg.Pool({
    host: config.PGHOST,
    port: config.PGPORT,
    user: config.PGUSER,
    password: config.PGPASSWORD,
    database: config.PGDATABASE,
  });

  const app = buildApp(config, pool, logger);
  app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, "Anilya ERP API listening");
  });
}

// Only auto-start when run directly (`node server.js`), not when
// imported by a test. Uses pathToFileURL rather than a raw string
// comparison — a plain `file://${process.argv[1]}` breaks on Windows,
// where backslash paths and drive-letter casing don't match the URL
// format `import.meta.url` produces, silently skipping this whole
// block (no error, no startup, no "listening" message — exactly the
// symptom this fixes).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Fatal startup error:", err);
    process.exit(1);
  });
}
