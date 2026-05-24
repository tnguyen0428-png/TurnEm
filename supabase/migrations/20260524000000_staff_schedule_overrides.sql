-- Per-date schedule override. Lets the receptionist tweak ONE day's hours
-- (or mark a tech off for the day) without touching the recurring weekly
-- blueprint in staff_schedules. Resolution order in the app:
--   1. staff_time_off range covers the date → tech is off
--   2. staff_schedule_overrides row exists for (mid, date) → that row wins
--   3. staff_schedules row for (mid, weekday) → blueprint hours
--   4. no row → off
--
-- is_working=false on an override means "off today" even if the blueprint
-- has hours; is_working=true with start/end means custom hours for that
-- single date. lunch_start/lunch_end double as a midday block window.

CREATE TABLE IF NOT EXISTS public.staff_schedule_overrides (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manicurist_id text NOT NULL,
  date         date NOT NULL,
  is_working   boolean NOT NULL DEFAULT true,
  start_time   time NOT NULL,
  end_time     time NOT NULL,
  lunch_start  time NULL,
  lunch_end    time NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_schedule_overrides_mid_date_uniq UNIQUE (manicurist_id, date)
);

CREATE INDEX IF NOT EXISTS staff_schedule_overrides_date_idx
  ON public.staff_schedule_overrides (date);
CREATE INDEX IF NOT EXISTS staff_schedule_overrides_mid_idx
  ON public.staff_schedule_overrides (manicurist_id);

ALTER TABLE public.staff_schedule_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated select staff_schedule_overrides"
  ON public.staff_schedule_overrides FOR SELECT
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated insert staff_schedule_overrides"
  ON public.staff_schedule_overrides FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated update staff_schedule_overrides"
  ON public.staff_schedule_overrides FOR UPDATE
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated delete staff_schedule_overrides"
  ON public.staff_schedule_overrides FOR DELETE
  USING (auth.uid() IS NOT NULL);

-- Realtime subscriptions: app subscribes via postgres_changes the same way
-- it does for staff_schedules. Skipped if already present.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'staff_schedule_overrides'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.staff_schedule_overrides';
  END IF;
END $$;
