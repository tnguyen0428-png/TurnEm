/*
  # Add priority columns to system_state

  Persists the Blueprint priority list (category order + per-category service order)
  on the singleton system_state row so it syncs across devices via Realtime instead
  of being trapped in each browser's localStorage.

  Schema:
    - category_priority jsonb — string[] of category names in priority order
    - service_priority  jsonb — Record<string, string[]> mapping category → ordered service names

  Both default to NULL meaning "not yet set" so the app can detect first-run and
  push up any existing localStorage values before the user is forced to redo the
  ordering. Once written, the realtime listener mirrors them into localStorage
  on every device so the legacy reads in assignHelpers continue to work.

  Idempotent: ADD COLUMN IF NOT EXISTS guards re-runs.
*/

ALTER TABLE system_state
  ADD COLUMN IF NOT EXISTS category_priority jsonb,
  ADD COLUMN IF NOT EXISTS service_priority  jsonb;
