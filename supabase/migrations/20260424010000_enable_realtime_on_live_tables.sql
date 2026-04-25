-- Enable Supabase Realtime on the tables that carry live salon operations.
-- After this migration, any INSERT/UPDATE/DELETE on these tables will be
-- broadcast over the `supabase_realtime` publication to all connected clients,
-- letting every device see each other's changes without a refresh.
--
-- Idempotent: each ALTER PUBLICATION is guarded by pg_publication_tables so
-- re-running this migration is a no-op.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'manicurists'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.manicurists;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'queue_entries'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.queue_entries;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'completed_services'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.completed_services;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'appointments'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.appointments;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'system_state'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.system_state;
  END IF;
END $$;

-- REPLICA IDENTITY FULL ensures DELETE events carry the full row
-- (not just the primary key), which the client uses to identify
-- which id to remove from local state.
ALTER TABLE public.manicurists        REPLICA IDENTITY FULL;
ALTER TABLE public.queue_entries      REPLICA IDENTITY FULL;
ALTER TABLE public.completed_services REPLICA IDENTITY FULL;
ALTER TABLE public.appointments       REPLICA IDENTITY FULL;
ALTER TABLE public.system_state       REPLICA IDENTITY FULL;
