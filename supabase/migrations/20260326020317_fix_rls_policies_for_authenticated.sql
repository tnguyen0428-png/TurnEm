/*
  # Fix RLS policies for first-migration tables

  1. Changes
    - Add authenticated-role policies to `manicurists`, `queue_entries`, and `completed_services`
    - These tables originally only had anon-role policies, but the app uses email/password auth
      so the authenticated role needs access too

  2. Security
    - Policies restrict access to authenticated users (auth.uid() IS NOT NULL)
    - Separate policies for SELECT, INSERT, UPDATE, DELETE
*/

-- manicurists: authenticated policies
CREATE POLICY "Authenticated users can select manicurists"
  ON manicurists FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert manicurists"
  ON manicurists FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update manicurists"
  ON manicurists FOR UPDATE
  TO authenticated
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can delete manicurists"
  ON manicurists FOR DELETE
  TO authenticated
  USING (auth.uid() IS NOT NULL);

-- queue_entries: authenticated policies
CREATE POLICY "Authenticated users can select queue_entries"
  ON queue_entries FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert queue_entries"
  ON queue_entries FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update queue_entries"
  ON queue_entries FOR UPDATE
  TO authenticated
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can delete queue_entries"
  ON queue_entries FOR DELETE
  TO authenticated
  USING (auth.uid() IS NOT NULL);

-- completed_services: authenticated policies
CREATE POLICY "Authenticated users can select completed_services"
  ON completed_services FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert completed_services"
  ON completed_services FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update completed_services"
  ON completed_services FOR UPDATE
  TO authenticated
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can delete completed_services"
  ON completed_services FOR DELETE
  TO authenticated
  USING (auth.uid() IS NOT NULL);
