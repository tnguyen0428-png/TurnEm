-- Receptionist time clock — move the clock-in/out log from per-browser
-- localStorage to Supabase so receptionist hours sync across every device
-- and are durable for payroll. Mirrors the shifts table's RLS pattern
-- (authenticated users only, auth.uid() IS NOT NULL).
--
-- staff_id is plain text (no FK) on purpose: the original localStorage log
-- always kept a stable staffId and sessionsFromEvents() groups by it. A FK
-- with ON DELETE SET NULL would null the id if a staff member were removed,
-- collapsing all ex-staff sessions together. staff_name is denormalized so
-- the report still renders the right name after a rename/removal.

CREATE TABLE IF NOT EXISTS clock_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id text NOT NULL,
  staff_name text NOT NULL DEFAULT '',
  type text NOT NULL CHECK (type IN ('in', 'out')),
  event_time timestamptz NOT NULL DEFAULT now(),
  note text NOT NULL DEFAULT '',
  edited boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clock_events_staff_time ON clock_events(staff_id, event_time);
CREATE INDEX IF NOT EXISTS idx_clock_events_event_time ON clock_events(event_time DESC);

ALTER TABLE clock_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY clock_events_select ON clock_events
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);
CREATE POLICY clock_events_insert ON clock_events
  FOR INSERT TO authenticated WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY clock_events_update ON clock_events
  FOR UPDATE TO authenticated USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY clock_events_delete ON clock_events
  FOR DELETE TO authenticated USING (auth.uid() IS NOT NULL);
