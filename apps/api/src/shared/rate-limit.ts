import rateLimit from "express-rate-limit";

// Phase 14: brute-force protection on authentication endpoints
// specifically — login, OTP request, OTP verify. 10 attempts per
// 15-minute window per IP, the same limit the original prototype's own
// security audit settled on. Deliberately NOT applied globally (a
// tight limit on every GET would just be an availability problem for
// legitimate traffic) — only on the handful of routes where brute-
// forcing actually matters.
//
// Skipped by default under NODE_ENV=test: this middleware is a single
// shared instance across the whole process (and, in the test suite,
// across every test FILE that imports server.ts — Node caches the
// module), so accumulated traffic from unrelated test files was
// genuinely tripping it and failing otherwise-correct tests. The real
// limiting behavior is NOT untested because of this — security.test.ts
// deliberately sends the X-Test-Rate-Limit header to opt back into the
// real code path for the one test that needs to prove the limit itself
// actually works.
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.NODE_ENV === "test" && req.headers["x-test-rate-limit"] !== "1",
  message: { error: "Too many attempts — please try again later" },
});
