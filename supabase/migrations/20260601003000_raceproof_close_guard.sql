-- Race-proof the post-close insert guard.
--
-- reject_ticket_items_on_closed_ticket_unconditional() previously read the
-- parent ticket's status with a plain SELECT. A ticket_items INSERT that
-- overlapped the close UPDATE could read a stale 'open' status in its MVCC
-- snapshot — microseconds before the close committed — and slip through.
--
-- Observed on ticket #70 (2026-05-31, Kat Paul): a bare-qid "Gel Fill $45"
-- row was inserted 0.4s AFTER the ticket closed, inflating the subtotal from
-- $90 to $135.
--
-- Fix: take FOR SHARE on the ticket row during the status read. A close/void
-- UPDATE holds FOR NO KEY UPDATE on that row, so the insert's read now BLOCKS
-- until the close commits, then sees the committed 'closed'/'voided' status
-- and rejects. Inside the close transaction itself the status is still 'open'
-- (not yet updated), so legitimate close-time lines are unaffected. No
-- deadlock risk: the insert only ever waits on the close, never vice-versa.
--
-- Also pins search_path (resolves the function_search_path_mutable advisor).
--
-- Applied live to the TurnEM Salon project on 2026-06-01.

CREATE OR REPLACE FUNCTION public.reject_ticket_items_on_closed_ticket_unconditional()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path = public, pg_temp
AS $function$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status
  FROM public.tickets
  WHERE id = NEW.ticket_id
  FOR SHARE;

  IF parent_status IN ('closed', 'voided') THEN
    RAISE NOTICE 'reject_ticket_items_on_closed_ticket_unconditional: dropping ticket_id=% status=% name=% staff1=% qid=%',
      NEW.ticket_id, parent_status, NEW.name, NEW.staff1_id, NEW.queue_entry_id;
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$function$;
