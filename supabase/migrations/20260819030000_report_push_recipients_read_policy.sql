-- The shift-close alert never left the register.
--
-- report_push_recipients was created by 20260819010000, and the ensure_rls
-- event trigger (cleanup_lock_down_rls_auto_enable) turned RLS on for it the
-- moment it existed. No policy was ever written, so the browser -- which holds
-- the anon key -- read ZERO recipients and pushToOwners() no-oped without an
-- error. The 11:30pm nightly push kept arriving because that one is sent from
-- pg_cron as postgres, which is not subject to RLS.
--
-- Read-only for the client. The row holds a synthetic push id and a label, and
-- push_subscriptions is already anon-readable, so this exposes nothing new.
-- Writes stay closed: recipients are added by migration or by the service role.
drop policy if exists "anon can read report_push_recipients" on public.report_push_recipients;
drop policy if exists "authenticated can read report_push_recipients" on public.report_push_recipients;

create policy "anon can read report_push_recipients"
  on public.report_push_recipients for select to anon using (true);

create policy "authenticated can read report_push_recipients"
  on public.report_push_recipients for select to authenticated using (true);
