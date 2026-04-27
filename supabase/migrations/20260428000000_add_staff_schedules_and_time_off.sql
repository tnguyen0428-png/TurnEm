/*
  # Staff schedules + time off

  Adds two tables to support per-technician working schedules with start/end
  times and lunch windows, plus separate vacation / PTO date ranges that
  override the recurring weekly schedule.

  ## staff_schedules

  One row per (manicurist, weekday) describing the technician's working hours
  for that recurring weekday. Absence of a row for a (manicurist, weekday)
  pair means the technician is off that day. weekday: 0=Sun … 6=Sat.

  Times are stored as `time` (HH:MM:SS) so we can use Postgres time
  arithmetic if needed later. Lunch is a single optional window per day.
  Multiple breaks would require another table; this matches the SalonBiz
  default and the agreed scope.

  ## staff_time_off

  Date-range PTO/vacation entries per technician. Overrides the recurring
  weekly schedule for the date range. Each row has start_date <= end_date
  and a free-form reason string.

  Both tables: RLS on, authenticated-only policies (matching existing
  tables). Realtime publication added so multi-device sees updates live.

  Idempotent: every CREATE/ALTER guarded by IF NOT EXISTS / DO blocks.
*/

-- ─── Tables ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS staff_schedules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manicurist_id   text NOT NULL REFERENCES manicurists(id) ON DELETE CASCADE,
  weekday         smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time      time NOT NULL,
  end_time        time NOT NULL,
  lunch_start     time,
  lunch_end       time,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (manicurist_id, weekday),
  CHECK (end_time > start_time),
  CHECK (
    (lunch_start IS NULL AND lunch_end IS NULL)
    OR (lunch_start IS NOT NULL AND lunch_end IS NOT NULL AND lunch_end > lunch_start)
  )
);

CREATE INDEX IF NOT EXISTS staff_schedules_manicurist_idx
  ON staff_schedules (manicurist_id);

CREATE TABLE IF NOT EXISTS staff_time_off (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manicurist_id   text NOT NULL REFERENCES manicurists(id) ON DELETE CASCADE,
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  reason          text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS staff_time_off_manicurist_idx
  ON staff_time_off (manicurist_id);
CREATE INDEX IF NOT EXISTS staff_time_off_range_idx
  ON staff_time_off (start_date, end_date);

-- ─── RLS ───────────────────────────────────────────────────────────────────

ALTER TABLE staff_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_time_off  ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated select staff_schedules' AND tablename = 'staff_schedules') THEN
    CREATE POLICY "Authenticated select staff_schedules"
      ON staff_schedules FOR SELECT TO authenticated
      USING (auth.uid() IS NOT NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated insert staff_schedules' AND tablename = 'staff_schedules') THEN
    CREATE POLICY "Authenticated insert staff_schedules"
      ON staff_schedules FOR INSERT TO authenticated
      WITH CHECK (auth.uid() IS NOT NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated update staff_schedules' AND tablename = 'staff_schedules') THEN
    CREATE POLICY "Authenticated update staff_schedules"
      ON staff_schedules FOR UPDATE TO authenticated
      USING (auth.uid() IS NOT NULL)
      WITH CHECK (auth.uid() IS NOT NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated delete staff_schedules' AND tablename = 'staff_schedules') THEN
    CREATE POLICY "Authenticated delete staff_schedules"
      ON staff_schedules FOR DELETE TO authenticated
      USING (auth.uid() IS NOT NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated select staff_time_off' AND tablename = 'staff_time_off') THEN
    CREATE POLICY "Authenticated select staff_time_off"
      ON staff_time_off FOR SELECT TO authenticated
      USING (auth.uid() IS NOT NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated insert staff_time_off' AND tablename = 'staff_time_off') THEN
    CREATE POLICY "Authenticated insert staff_time_off"
      ON staff_time_off FOR INSERT TO authenticated
      WITH CHECK (auth.uid() IS NOT NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated update staff_time_off' AND tablename = 'staff_time_off') THEN
    CREATE POLICY "Authenticated update staff_time_off"
      ON staff_time_off FOR UPDATE TO authenticated
      USING (auth.uid() IS NOT NULL)
      WITH CHECK (auth.uid() IS NOT NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated delete staff_time_off' AND tablename = 'staff_time_off') THEN
    CREATE POLICY "Authenticated delete staff_time_off"
      ON staff_time_off FOR DELETE TO authenticated
      USING (auth.uid() IS NOT NULL);
  END IF;
END $$;

-- ─── Realtime publication + replica identity ──────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'staff_schedules'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.staff_schedules;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'staff_time_off'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.staff_time_off;
  END IF;
END $$;

ALTER TABLE public.staff_schedules REPLICA IDENTITY FULL;
ALTER TABLE public.staff_time_off  REPLICA IDENTITY FULL;
