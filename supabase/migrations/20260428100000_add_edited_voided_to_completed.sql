-- Adds edit/void flags to completed_services so the EDIT and VOID badges in
-- History survive a roundtrip to Supabase and back via realtime sync.
-- Without these columns, UPDATE_COMPLETED stamps `edited: true` locally,
-- the upsert silently drops it, then the realtime echo overwrites the local
-- state with `edited: undefined` and the badge disappears.
--
-- edited: boolean — true once a row has been modified via the History edit modal.
-- voided: boolean — true when the row was voided (kept for visibility, excluded
--                   from turn totals).

ALTER TABLE completed_services
  ADD COLUMN IF NOT EXISTS edited boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS voided boolean NOT NULL DEFAULT false;
