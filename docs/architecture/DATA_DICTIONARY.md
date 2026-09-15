# Data Dictionary — Anilya ERP
73 tables total (verified: `grep -c "CREATE TABLE IF NOT EXISTS"` across `db.js` + `inventory-db.js`), grouped by domain. Full column-level detail lives in the source files themselves (both are heavily commented, line-by-line, at the point of definition) — this dictionary is the map, not a duplicate of the schema.

| Domain | Tables | Source file |
|---|---|---|
| **Orders & Jobs (core)** | `orders`, `jobs`, `order_events`, `job_types`, `gang_runs`, `gang_run_jobs`, `parcels`, `parcel_orders` | `db.js` |
| **Customers & Finance** | `customers`, `customer_ledger`, `payment_transactions`, `refund_requests`, `wallet_credits`, `cod_collections`, `accounting_clearance_tasks` | `db.js` |
| **Identity, Auth, Audit** | `users`, `staff_sessions`, `partners`, `partner_capabilities`, `capability_types`, `sessions`, `customer_sessions`, `operator_sessions`, `login_otps` *(dead)*, `otp_requests`, `otp_channel_deliveries`, `login_sessions`, `audit_logs`, `integration_keys` | `db.js` |
| **Vendor Rates & Payments** | `vendor_master_rates`, `vendor_payments`, `rate_audit_log` | `db.js` |
| **Artwork Operator Ledger** | `artwork_operators`, `operator_ledger`, `operator_payments` | `db.js` |
| **Files & Uploads** | `files`, `upload_sessions` | `db.js` |
| **Invoice / OTP-download** | `invoice_otps`, `invoice_otp_log` | `db.js` |
| **Additional (Extra) Services** | `additional_service_requests`, `additional_service_items`, `removal_notices`, `support_tickets` | `db.js` |
| **Notifications** | `notification_types`, `notification_rules`, `notifications`, `notification_log` | `db.js` |
| **Departments & Scope** | `departments`, `supervisor_departments`, `product_categories`, `cities`, `partner_product_categories`, `partner_cities` | `db.js` |
| **Feedback & Complaints** | `feedback`, `complaint_tickets`, `complaint_evidence`, `complaint_audit_log` | `db.js` |
| **Inventory Phase 1 (isolated module)** | `inventory_products`, `inventory_product_external_map`, `inventory_product_warehouse_policy`, `inventory_zones`, `inventory_cities`, `inventory_warehouses`, `inventory_suppliers`, `inventory_product_suppliers`, `inventory_ledger`, `inventory_stock`, `inventory_reservations`, `inventory_user_scope`, `inventory_audit_log`, `inventory_integration_events`, `inventory_outbox`, `inventory_dead_letter` | `inventory-db.js` |

## Cross-cutting observations (evidence for the Risk Register)

- **No table has an `organization_id`/`tenant_id` column.** Confirmed by inspecting every `CREATE TABLE` statement — this is a schema-wide, not a per-table, gap (RISK-001).
- **Three separate audit-shaped tables exist** (`audit_logs`, `complaint_audit_log`, `rate_audit_log`) plus a fourth (`inventory_audit_log`) in the isolated Inventory module — four independent audit trails, not one (RISK-008).
- **Three separate session tables** for non-staff identities (`sessions` for Partners, `customer_sessions`, `operator_sessions`) exist because SQLite foreign keys forced this split during the Centralized Auth build (a Partner-only FK on the original `sessions` table couldn't accept a Customer or Operator id) — a real relational-identity model (single `identities` table with a `type` discriminator) would collapse these to one.
- **`login_otps` is dead** — schema-present, zero live references (RISK-016).
- **Every ledger table (`customer_ledger`, `operator_ledger`, `inventory_ledger`) independently reimplements the same append-only pattern** (`previous_balance`/`delta`/`final_balance`) rather than sharing one ledger primitive — correct in each instance, but three parallel implementations of the same idea.
