/*
  # Fix RLS policies for daily_history — switch anon → authenticated

  The original daily_history migration created anon-role policies, but the app
  uses email/password auth (authenticated role). Upserts from authenticated
  sessions were blocked, causing silent save failures on archive/reset.

  Changes:
    - Drop the four anon policies
    - Add authenticated-role SELECT / INSERT / UPDATE / DELETE policies
*/

-- Drop old anon-only policies
DROP POLICY IF EXISTS "Allow anon select daily_history" ON daily_history;
DROP POLICY IF EXISTS "Allow anon insert daily_history" ON daily_history;
DROP POLICY IF EXISTS "Allow anon update daily_history" ON daily_history;
DROP POLICY IF EXISTS "Allow anon delete daily_history" ON daily_history;

-- Add authenticated-role policies
CREATE POLICY "Authenticated users can select daily_history"
  ON daily_history FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert daily_history"
  ON daily_history FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update daily_history"
  ON daily_history FOR UPDATE
  TO authenticated
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can delete daily_history"
  ON daily_history FOR DELETE
  TO authenticated
  USING (auth.uid() IS NOT NULL);
