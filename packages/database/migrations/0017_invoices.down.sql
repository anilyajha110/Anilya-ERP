DROP TABLE IF EXISTS invoice_number_counters;
DROP TABLE IF EXISTS invoices;
ALTER TABLE orders DROP COLUMN order_value;
ALTER TABLE orders DROP CONSTRAINT orders_stage_check;
ALTER TABLE orders ADD CONSTRAINT orders_stage_check
  CHECK (stage IN ('imported', 'confirmed', 'in_progress', 'completed', 'cancelled'));
