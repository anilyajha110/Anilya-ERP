ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_otp_request_fk;
DROP TABLE IF EXISTS otp_channel_deliveries;
DROP TABLE IF EXISTS otp_requests;
