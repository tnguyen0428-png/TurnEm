-- Remove the content-based duplicate-appointment guard. It dropped any new
-- appointment matching an existing one on (date, manicurist, time, client,
-- service) -- silently rejecting LEGITIMATE bookings ("disappearing slots").
-- Phantom duplicates are now prevented at the source: walk-in synth blocks
-- carry a stable `walkin:<queueId>` id, so re-synths collapse by id instead of
-- creating new rows. Id-based dedup (primary key + onConflict:id + the client
-- reducer's id check) is now the sole dedup. Two genuinely distinct bookings
-- always get distinct ids, so real repeats survive.
--
-- The appointment_drop_log table is kept for historical reference; it simply
-- stops receiving new rows once the trigger is gone.

DROP TRIGGER IF EXISTS appointments_reject_duplicate ON public.appointments;
DROP FUNCTION IF EXISTS public.reject_duplicate_appointment();
