-- #318: system_events records non-bid, non-alert daemon events for the
-- unified History log:
--   * 'config_change' - one row per changed config field on a save,
--     carrying the field name and its old/new values.
--   * 'daemon_started' - one row per boot (detail = build number), so a
--     restart is visible in the log even when the run mode didn't change.
CREATE TABLE system_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  field TEXT,
  old_value TEXT,
  new_value TEXT,
  detail TEXT
);

CREATE INDEX idx_system_events_occurred_at ON system_events(occurred_at);
