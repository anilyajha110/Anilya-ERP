-- 0001_app_health: proves the migration mechanism works end-to-end.
-- Used by the API's /health and /ready endpoints to confirm a real
-- round-trip to the database, not just that the process is running.
CREATE TABLE app_health (
  id          SMALLINT PRIMARY KEY DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'ok',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT app_health_singleton CHECK (id = 1)
);

INSERT INTO app_health (id, status) VALUES (1, 'ok');
