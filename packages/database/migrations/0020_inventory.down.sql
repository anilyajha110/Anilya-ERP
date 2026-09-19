DROP TABLE IF EXISTS inventory_inbound_events;
DROP TRIGGER IF EXISTS inventory_ledger_no_delete ON inventory_ledger;
DROP TRIGGER IF EXISTS inventory_ledger_no_update ON inventory_ledger;
DROP TABLE IF EXISTS inventory_ledger;
DROP TABLE IF EXISTS inventory_reservations;
DROP TABLE IF EXISTS inventory_stock;
DROP TABLE IF EXISTS inventory_warehouses;
DROP TABLE IF EXISTS inventory_product_external_map;
DROP TABLE IF EXISTS inventory_products;
