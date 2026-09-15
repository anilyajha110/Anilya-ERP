# Integration Catalog — Anilya ERP

Every point where this system talks to something outside itself — real or simulated. The blueprint's Phase 0 explicitly wants these mapped since "API-first integration" and "external providers behind adapters" are Mandatory Principles.

## Simulated external systems (bridge endpoints exist; the other side does not)

| External system | Bridge endpoints | What's actually simulated |
|---|---|---|
| Booking Portal (anilyya.com) | `POST /api/orders/import` (inbound) | The Portal itself doesn't exist; orders are injected via direct API calls in every test session. |
| Artwork Management System (AMS) | `GET/POST /api/artwork-queue/*`, `/api/internal-artwork-queue/*`, `/api/gang-artwork-queue/*`, `/api/artwork/:orderId/*` | AMS is fully internal — these are bridge-shaped endpoints a *real* AMS would call, but nothing outside this Express process ever calls them today. |
| Inventory & Supplier App | `GET/POST /api/inventory-bridge/*` (legacy) + the entire separate Inventory Phase 1 module | Inventory Phase 1 is itself simulating what would eventually be its own service. |
| Payment Gateway (refunds) | `GET/POST /api/refund-bridge/*` | No real gateway; `refund_requests.status` stays `Pending` forever without a human/script advancing it. |
| Wallet & Credit App | `GET/POST /api/wallet-bridge/*` | Same pattern. |
| Delivery App (COD) | `GET/POST /api/cod-bridge/*` | Same pattern. |
| SMS/WhatsApp/Email gateway | Called implicitly by every OTP/notification flow | Zero real integration; every OTP is returned directly in the API response as `demoOtp`. |

## Real integrations (nothing external, but genuinely wired)

| Integration | Where |
|---|---|
| bcrypt password hashing | `users`, `partners` |
| SHA-256 OTP/API-key hashing | `otp_requests`, `integration_keys` |
| multer file upload (local disk) | Every upload endpoint — see RISK-005 |

## Integration credentials / keys

| Mechanism | Note |
|---|---|
| `integration_keys` table, SHA-256-hashed | Used by the legacy inventory-bridge endpoints; the newer Inventory Phase 1 module and Artwork bridges have **no equivalent system-to-system credential check at all** — they're open once network access is available. This is a real gap: some bridges are key-protected, most aren't. |

## What a real integration layer needs that doesn't exist yet
- Webhook signature verification (nothing here verifies an inbound call's authenticity beyond the one `integration_keys` check on the oldest bridge).
- Retry/backoff contracts for OUTBOUND calls to a real external system (the Inventory module's own outbox is the only place this exists at all).
- Per-integration rate limiting distinct from the general `authLimiter`.
- A circuit breaker / dead-letter pattern generalized beyond the Inventory module (which has one; nothing else does).
