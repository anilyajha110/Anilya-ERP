import pino from "pino";
import type { Config } from "../config/config.js";

// Structured JSON logging (Phase 1 requirement) — every log line is
// machine-parseable and, once request context binds a correlation id
// (see correlation-id.ts), traceable across a single request's full
// lifecycle. Never logs secrets: redact known-sensitive keys by default.
export function createLogger(config: Config) {
  return pino({
    level: config.LOG_LEVEL,
    redact: {
      paths: ["req.headers.authorization", "*.password", "*.password_hash", "*.otp", "*.token", "*.secret"],
      censor: "[REDACTED]",
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof createLogger>;
