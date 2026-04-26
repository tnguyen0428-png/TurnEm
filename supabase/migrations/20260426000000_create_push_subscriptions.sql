/*
  # Create push_subscriptions table

  This table is referenced by:
    - supabase/functions/send-push/index.ts (lines 281, 335) — looks up
      subscriptions for a manicurist before sending Web Push, and deletes
      expired subscriptions.
    - src/utils/pushNotifications.ts (line 27) — fetches the set of
      manicurist_ids that currently have a subscription, used to render
      "subscribed" badges in the staff portal.

  The migration was missing from previous deploys; any environment built
  cleanly from supabase/migrations/ would 404 on those calls.

  Schema:
    - id: uuid primary key (so multiple devices per manicurist can each
      have their own row)
    - manicurist_id: uuid FK -> manicurists(id) ON DELETE CASCADE (when a
      manicurist is removed, drop their subscriptions)
    - endpoint: text UNIQUE (the Web Push endpoint URL — globally unique
      per browser/device)
    - p256dh: text (P-256 ECDH public key, base64url)
    - auth: text (HMAC auth secret, base64url)
    - created_at: timestamptz default now()

  RLS:
    - Authenticated users can INSERT/SELECT/UPDATE/DELETE.
    - The send-push edge function uses the service role key and bypasses
      RLS for its lookups and expired-subscription cleanup.
*/

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manicurist_id uuid NOT NULL REFERENCES manicurists(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_manicurist_id
  ON push_subscriptions(manicurist_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'push_subscriptions'
      AND policyname = 'authenticated can read push_subscriptions'
  ) THEN
    CREATE POLICY "authenticated can read push_subscriptions"
      ON push_subscriptions FOR SELECT
      TO authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'push_subscriptions'
      AND policyname = 'authenticated can insert push_subscriptions'
  ) THEN
    CREATE POLICY "authenticated can insert push_subscriptions"
      ON push_subscriptions FOR INSERT
      TO authenticated
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'push_subscriptions'
      AND policyname = 'authenticated can update push_subscriptions'
  ) THEN
    CREATE POLICY "authenticated can update push_subscriptions"
      ON push_subscriptions FOR UPDATE
      TO authenticated
      USING (true)
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'push_subscriptions'
      AND policyname = 'authenticated can delete push_subscriptions'
  ) THEN
    CREATE POLICY "authenticated can delete push_subscriptions"
      ON push_subscriptions FOR DELETE
      TO authenticated
      USING (true);
  END IF;
END $$;
