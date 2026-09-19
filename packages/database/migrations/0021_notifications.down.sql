DROP TABLE IF EXISTS notification_deliveries;
DROP TRIGGER IF EXISTS notifications_no_delete ON notifications;
DROP TRIGGER IF EXISTS notifications_no_update ON notifications;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS notification_routing_rules;
DROP TABLE IF EXISTS notification_types;
