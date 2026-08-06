-- Allow the ON DELETE SET NULL cascade from manicurists -> ticket_items
-- (staff1_id/staff2_id) to go through even when the ticket_item's parent
-- ticket is voided. The guard trigger previously blocked ANY modification
-- to a voided ticket's line items, which incidentally blocked the FK
-- cascade too -- meaning deleting a manicurist who had ever worked a
-- since-voided ticket was permanently impossible (Lisa, 2026-08-06).
--
-- This narrows the block: an UPDATE that ONLY clears staff1_id and/or
-- staff2_id to NULL (with every other column unchanged) is allowed --
-- that's exactly the shape of the automatic FK cascade. Any real edit
-- (reassigning to a different staff id, changing price/qty/name) or an
-- outright insert/delete of the row still raises the exception, same as
-- before.
CREATE OR REPLACE FUNCTION public.guard_ticket_items_on_voided_ticket()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  parent_status text;
  v_ticket_id uuid;
BEGIN
  v_ticket_id := COALESCE(NEW.ticket_id, OLD.ticket_id);
  SELECT status INTO parent_status FROM tickets WHERE id = v_ticket_id;
  IF parent_status IS NULL THEN
    -- Parent doesn't exist; let FK / cascade handle it.
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF parent_status = 'voided' THEN
    IF TG_OP = 'UPDATE'
       AND (to_jsonb(NEW) - 'staff1_id' - 'staff2_id') = (to_jsonb(OLD) - 'staff1_id' - 'staff2_id')
       AND (NEW.staff1_id IS NOT DISTINCT FROM OLD.staff1_id OR NEW.staff1_id IS NULL)
       AND (NEW.staff2_id IS NOT DISTINCT FROM OLD.staff2_id OR NEW.staff2_id IS NULL)
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Cannot modify ticket_items on voided ticket % (status=voided).', v_ticket_id
      USING ERRCODE = '23514';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;
