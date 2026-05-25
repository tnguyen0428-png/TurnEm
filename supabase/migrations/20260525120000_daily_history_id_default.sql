/*
  # Add default to daily_history.id

  The nightly-save-history edge function was passing `id: crypto.randomUUID()`
  on every upsert. Supabase's upsert UPDATE writes every column from the
  payload — so on every nightly run, the primary-key value of the row for
  the same `date` was being churned to a fresh UUID. The function has been
  updated to omit `id` from the upsert payload; this migration adds the
  column default so INSERT (first save for a brand-new date) still works.

  Idempotent: ALTER COLUMN ... SET DEFAULT is safe to re-run.
*/

ALTER TABLE daily_history
  ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
