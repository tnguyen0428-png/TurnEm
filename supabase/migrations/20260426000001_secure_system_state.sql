/*
  # Tighten system_state RLS

  The original migration (20260409000000_create_system_state.sql) created a
  policy `allow all on system_state` with role `public`, USING (true), and
  WITH CHECK (true). That allows anonymous callers (with the project's
  anon key) to UPDATE last_archive_date and admin_passcode — both of which
  are control-plane state.

  After 20260424020000_reconcile_drift.sql added admin_passcode, this hole
  became a real escalation path: anyone with the anon key can rotate the
  admin PIN.

  Fix: drop the public/all-true policy and replace with authenticated-only
  per-operation policies. The salon front-desk app already authenticates
  every device, so tightening to authenticated does not break legitimate
  use; staff-mode read-only sessions also authenticate before touching
  state.

  Idempotent: drops the policy IF EXISTS, recreates each new policy IF NOT
  EXISTS. Safe to re-run.
*/

DROP POLICY IF EXISTS "allow all on system_state" ON system_state;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'system_state'
      AND policyname = 'authenticated can read system_state'
  ) THEN
    CREATE POLICY "authenticated can read system_state"
      ON system_state FOR SELECT
      TO authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'system_state'
      AND policyname = 'authenticated can insert system_state'
  ) THEN
    CREATE POLICY "authenticated can insert system_state"
      ON system_state FOR INSERT
      TO authenticated
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'system_state'
      AND policyname = 'authenticated can update system_state'
  ) THEN
    CREATE POLICY "authenticated can update system_state"
      ON system_state FOR UPDATE
      TO authenticated
      USING (true)
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'system_state'
      AND policyname = 'authenticated can delete system_state'
  ) THEN
    CREATE POLICY "authenticated can delete system_state"
      ON system_state FOR DELETE
      TO authenticated
      USING (true);
  END IF;
END $$;
