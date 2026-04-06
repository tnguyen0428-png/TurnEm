/*
  # Create daily_history table

  Stores one row per calendar date (YYYY-MM-DD). The `entries` column is a
  JSONB array of CompletedEntry objects — same camelCase + ms-timestamp shape
  that the app's saveTodayHistory / loadInitialData already use, so no mapping
  is needed on read.

  Schema reverse-engineered from AppContext.tsx:
    saveTodayHistory  → upsert({ id, date, entries }, { onConflict: 'date' })
    loadInitialData   → select('*') order by date desc
                        row.id (string), row.date (string), row.entries (jsonb)

  Idempotent: CREATE TABLE IF NOT EXISTS + DO-block policy guards.
  Safe to run even if the table was created manually in the Supabase dashboard.
*/

CREATE TABLE IF NOT EXISTS daily_history (
  id   text        PRIMARY KEY,
  date text        NOT NULL,
  entries jsonb    NOT NULL DEFAULT '[]'::jsonb
);

-- Unique constraint on date is what onConflict: 'date' relies on.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'daily_history'::regclass
      AND contype = 'u'
      AND conname = 'daily_history_date_key'
  ) THEN
    ALTER TABLE daily_history ADD CONSTRAINT daily_history_date_key UNIQUE (date);
  END IF;
END $$;

ALTER TABLE daily_history ENABLE ROW LEVEL SECURITY;

-- SELECT
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'daily_history' AND policyname = 'Allow anon select daily_history'
  ) THEN
    CREATE POLICY "Allow anon select daily_history"
      ON daily_history FOR SELECT
      TO anon
      USING (auth.jwt() ->> 'role' = 'anon');
  END IF;
END $$;

-- INSERT
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'daily_history' AND policyname = 'Allow anon insert daily_history'
  ) THEN
    CREATE POLICY "Allow anon insert daily_history"
      ON daily_history FOR INSERT
      TO anon
      WITH CHECK (auth.jwt() ->> 'role' = 'anon');
  END IF;
END $$;

-- UPDATE
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'daily_history' AND policyname = 'Allow anon update daily_history'
  ) THEN
    CREATE POLICY "Allow anon update daily_history"
      ON daily_history FOR UPDATE
      TO anon
      USING  (auth.jwt() ->> 'role' = 'anon')
      WITH CHECK (auth.jwt() ->> 'role' = 'anon');
  END IF;
END $$;

-- DELETE
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'daily_history' AND policyname = 'Allow anon delete daily_history'
  ) THEN
    CREATE POLICY "Allow anon delete daily_history"
      ON daily_history FOR DELETE
      TO anon
      USING (auth.jwt() ->> 'role' = 'anon');
  END IF;
END $$;
