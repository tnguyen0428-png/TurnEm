/*
  # Create system_state table

  Stores a single singleton row that tracks the last date the daily archive+reset ran.
  Used by loadInitialData on startup to detect missed resets (e.g. app was closed at 11:59pm).

  Schema:
    - id: text PRIMARY KEY — always 'singleton'
    - last_archive_date: date — the last LA-timezone date a DAILY_RESET was successfully run
    - updated_at: timestamptz — when the row was last written

  How it works:
    - archiveTodayIfNeeded() writes last_archive_date = today (LA) after every successful reset
    - loadInitialData reads last_archive_date on startup; if it's behind today, the reset was missed
    - Startup then re-runs the stale-data recovery path and updates last_archive_date to today

  Idempotent: CREATE TABLE IF NOT EXISTS + policy guards.
*/

CREATE TABLE IF NOT EXISTS system_state (
  id text PRIMARY KEY,
  last_archive_date date,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE system_state ENABLE ROW LEVEL SECURITY;

-- Seed the singleton row if it doesn't exist yet
INSERT INTO system_state (id, last_archive_date, updated_at)
VALUES ('singleton', NULL, now())
ON CONFLICT (id) DO NOTHING;

-- RLS: allow all (this is a single-device front-desk app with email auth)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'system_state' AND policyname = 'allow all on system_state'
  ) THEN
    CREATE POLICY "allow all on system_state"
      ON system_state FOR ALL
      TO public
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;
