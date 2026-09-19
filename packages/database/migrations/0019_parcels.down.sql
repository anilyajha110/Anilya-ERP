DROP TABLE IF EXISTS parcel_orders;
DROP TABLE IF EXISTS parcels;
ALTER TABLE orders DROP CONSTRAINT orders_stage_check;
ALTER TABLE orders ADD CONSTRAINT orders_stage_check
  CHECK (stage IN ('imported', 'confirmed', 'in_progress', 'completed', 'delivered', 'cancelled'));
