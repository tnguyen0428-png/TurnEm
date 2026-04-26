/*
  # Drop residual anon-role policies on push_subscriptions

  When 20260426000000_create_push_subscriptions.sql was first authored we
  assumed the table did not exist in production. It turned out the table
  had already been created directly in the Supabase dashboard with three
  anon policies: "Allow anonymous select/insert/delete". Same hole as the
  one closed in 20260426000002 for manicurists/queue_entries/completed_services.

  The app authenticates via email/password (see src/state/AuthContext.tsx)
  and the send-push edge function uses the service_role key (which bypasses
  RLS), so anon access on push_subscriptions is dead surface area.

  Idempotent: DROP POLICY IF EXISTS. Safe to re-run.
*/

DROP POLICY IF EXISTS "Allow anonymous select" ON push_subscriptions;
DROP POLICY IF EXISTS "Allow anonymous insert" ON push_subscriptions;
DROP POLICY IF EXISTS "Allow anonymous delete" ON push_subscriptions;
