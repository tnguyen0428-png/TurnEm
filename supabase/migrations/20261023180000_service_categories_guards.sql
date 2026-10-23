-- Server-side backstop for the rules the reducer already enforces, so a
-- stale client, a second app, or a hand-written query can't break them:
--   * Locked categories (Combo, Wax Services) are matched by NAME in the turn
--     rules, so they can't be deleted, renamed, re-keyed or unlocked.
--     Recolor and reorder still pass.
--   * A category that still has services can't be deleted (services store
--     their category by name and would be orphaned).
-- Deliberately no FK from salon_services.category: the client syncs the
-- renamed services before the renamed category row, so an FK would reject
-- every rename.
CREATE OR REPLACE FUNCTION service_categories_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF OLD.is_locked THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'service category "%" is locked and cannot be deleted', OLD.name;
    END IF;
    IF NEW.name IS DISTINCT FROM OLD.name THEN
      RAISE EXCEPTION 'service category "%" is locked and cannot be renamed', OLD.name;
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'service category "%" is locked and its id cannot change', OLD.name;
    END IF;
    IF NOT NEW.is_locked THEN
      RAISE EXCEPTION 'service category "%" is locked and cannot be unlocked', OLD.name;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM salon_services WHERE category = OLD.name) THEN
      RAISE EXCEPTION 'service category "%" still has services', OLD.name;
    END IF;
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS service_categories_guard ON service_categories;
CREATE TRIGGER service_categories_guard
  BEFORE UPDATE OR DELETE ON service_categories
  FOR EACH ROW EXECUTE FUNCTION service_categories_guard();
