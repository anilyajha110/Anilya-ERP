import { z } from "zod";

// Phase 1 requirement: "configuration validation." The process must
// refuse to start with bad config rather than fail confusingly on the
// first request that needs the missing value.
//
// ALLOWED_ORIGINS (Phase 14 — closes RISK-011 from the Phase 0 audit):
// closed by default, not open-until-configured. Empty/unset means "no
// cross-origin requests allowed at all" — safe, if restrictive.
// Production specifically MUST set this explicitly; an operator who
// forgets gets a loud startup failure, not a silently wide-open API.
const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    PGHOST: z.string().min(1),
    PGPORT: z.coerce.number().int().positive().default(5432),
    PGUSER: z.string().min(1),
    PGPASSWORD: z.string().default(""),
    PGDATABASE: z.string().min(1),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    ALLOWED_ORIGINS: z.string().default(""),
  })
  .transform((cfg) => ({
    ...cfg,
    allowedOrigins: cfg.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
  }))
  .refine(
    (cfg) => cfg.NODE_ENV !== "production" || cfg.allowedOrigins.length > 0,
    { message: "ALLOWED_ORIGINS must be set explicitly in production — refusing to start with CORS silently wide open", path: ["ALLOWED_ORIGINS"] }
  );

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    // Fail fast, fail loud, at startup — never partway through serving traffic.
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return result.data;
}
