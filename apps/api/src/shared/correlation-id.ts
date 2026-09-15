import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// Phase 1 requirement: "structured errors/logging/correlation IDs."
// Accepts an inbound X-Correlation-Id (so an upstream caller's trace
// survives across this service), or mints a new one. Every log line
// and every error response inside this request carries the same id.
declare global {
  namespace Express {
    interface Request {
      correlationId: string;
    }
  }
}

export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header("x-correlation-id");
  const correlationId = incoming && incoming.length > 0 ? incoming : randomUUID();
  req.correlationId = correlationId;
  res.setHeader("x-correlation-id", correlationId);
  next();
}
