/*
  # Drop residual anon-role policies on core tables

  The very first migration (20260326012431_create_salon_schema.sql) added
  full SELECT/INSERT/UPDATE/DELETE policies for the `anon` role on three
  tables: manicurists, queue_entries, completed_services. Migration
  20260326020317 added a parallel set of `authenticated` policies, but
  it never dropped the anon policies — so anyone with the project's anon
  key (which ships in the client bundle) can still read AND write all
  three tables without logging in.

  The app authenticates real users via Supabase email/password (see
  src/state/AuthContext.tsx and src/components/auth/LoginScreen.tsx), so
  the authenticated policies are sufficient. The anon policies are dead
  surface area.

  This migration drops the 12 anon policies. Edge functions that need
  unauthenticated access (none currently — send-sms and send-push both
  use the service-role key for their own DB lookups) are unaffected.

  Idempotent: DROP POLICY IF EXISTS. Safe to re-run.
*/

-- manicurists
DROP POLICY IF EXISTS "Allow anon select manicurists" ON manicurists;
DROP POLICY IF EXISTS "Allow anon insert manicurists" ON manicurists;
DROP POLICY IF EXISTS "Allow anon update manicurists" ON manicurists;
DROP POLICY IF EXISTS "Allow anon delete manicurists" ON manicurists;

-- queue_entries
DROP POLICY IF EXISTS "Allow anon select queue_entries" ON queue_entries;
DROP POLICY IF EXISTS "Allow anon insert queue_entries" ON queue_entries;
DROP POLICY IF EXISTS "Allow anon update queue_entries" ON queue_entries;
DROP POLICY IF EXISTS "Allow anon delete queue_entries" ON queue_entries;

-- completed_services
DROP POLICY IF EXISTS "Allow anon select completed_services" ON completed_services;
DROP POLICY IF EXISTS "Allow anon insert completed_services" ON completed_services;
DROP POLICY IF EXISTS "Allow anon update completed_services" ON completed_services;
DROP POLICY IF EXISTS "Allow anon delete completed_services" ON completed_services;
