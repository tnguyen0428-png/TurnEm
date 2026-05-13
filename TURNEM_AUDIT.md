# TurnEm — Local Static Audit

Scope: a code-only scan across `src/`, `supabase/migrations/`, and `supabase/functions/`. No build, lint, or runtime was executed; findings come from reading the source.

Each item: file → line(s) → what's wrong → why it matters → suggested fix. Severity is the auditor's best guess from a static read; a few "high" items below are *suspected* races that warrant a manual repro before fixing.

✅ = personally verified by re-reading the file. ◻ = surfaced by the audit pass and worth confirming with a quick read before acting.

---

## CRITICAL — fix before anything else

### C1. `send-sms` edge function has no auth and CORS `*` ✅
`supabase/functions/send-sms/index.ts` — entire handler.

The function accepts `{ to, message }` from any origin with no `Authorization` check. `Access-Control-Allow-Origin: *` (line 4) makes it callable from any website. Anyone who knows the function URL can send SMS to any number on your Twilio account.

**Fix:** verify a Supabase JWT at the top of the handler (`req.headers.get('Authorization')` → `supabase.auth.getUser(token)`), and replace `*` with your app's origin. Add a per-user / per-number rate limit (e.g., 10 sends/min) before hitting Twilio.

### C2. Admin PIN `'072499'` hardcoded as column default ✅
`supabase/migrations/20260424020000_reconcile_drift.sql:100`

```
ALTER TABLE system_state ADD COLUMN admin_passcode text NOT NULL DEFAULT '072499';
```

The PIN is in version control and therefore compromised. The follow-up migration `20260426000001_secure_system_state.sql` even calls this out as "a real escalation path" once anon RLS is fixed. As long as this default exists, anyone with repo access knows the PIN.

**Fix:** rotate the PIN in production immediately. In a new migration, drop the default (`ALTER COLUMN admin_passcode DROP DEFAULT`) and require it to be set via the admin UI on first run.

### C3. `daily_history` still has open `anon` RLS policies ✅
`supabase/migrations/20260405100000_create_daily_history.sql:44–94`

Four policies (`SELECT/INSERT/UPDATE/DELETE`) granted `TO anon` with `USING (auth.jwt() ->> 'role' = 'anon')`. The April 26 hardening pass that removed `anon` policies elsewhere did not touch this table. Anyone holding the public anon key can read or destroy the salon's history archive.

**Fix:** add a migration that drops all four policies and re-creates them `TO authenticated` with whatever role/owner check matches the rest of the schema.

---

## HIGH — wrong behavior under normal use

### H1. `inFlightAutoCreates` set is never cleared ✅
`src/state/AppContext.tsx:1228, 1334–1346`

The module-level `Set<string>` is added to before each `createTicketAtCheckin` call, but the surrounding `try/catch` (lines 1334–1346) never removes the visit id on success or failure. The early-skip at line 1291 then permanently blocks any later auto-create for the same `visitId`. In a long-running tab a single failure orphans the visit forever.

**Fix:** wrap the create in `try { … } finally { inFlightAutoCreates.delete(visitId); }`. Also consider clearing the set on `LOAD_STATE` reconciliations.

### H2. `pushNotifications.ts` returns `success: true` with a non-null `error` ✅
`src/utils/pushNotifications.ts:198`

```
return { success: true, error: JSON.stringify(debugInfo) };
```

Any caller using the conventional `if (result.error) toastFailure()` will report a successful send as a failure. `error` should be `null`/absent on success and the `debugInfo` payload should live under a separate field (`debug` / `info`).

**Fix:** `return { success: true, debug: debugInfo };` and update callers (search for `sendPushNotification(`).

### H3. Initial-load Supabase fetches don't all check errors ◻
`src/state/AppContext.tsx` `loadInitialData` (~line 393–440)

Only the staff and service errors are inspected; queue, completed, appointments, calendar, daily_history, schedule, and time-off responses are read straight into state even if `error` is non-null and `data` is empty. A transient Postgres timeout silently boots the app with empty state and then the next `syncQueue` round-trip can write that empty state back to the server.

**Fix:** check `error` on every result; if any one fails, set the syncError banner and bail before the LOAD_STATE dispatch so the empty-state-clobber path can't run.

### H4. `appointmentWriteChain` swallows errors and continues ◻
`src/state/AppContext.tsx:352–359`

The chain uses `.then(fn, fn)` (success and failure both invoke the next op). A failed DELETE therefore lets a queued UPSERT for the same row proceed, which is the textbook resurrection bug.

**Fix:** chain with `.then(fn).catch(err => { logger.error(err); throw err; })` so failures stop the queue and bubble to the syncError handler. Add a small backoff/retry around individual ops if you don't want the whole chain to die on one transient failure.

### H5. Push subscriptions / system_state RLS is `USING (true)` ◻
`supabase/migrations/20260426000000_create_push_subscriptions.sql` and `20260426000001_secure_system_state.sql`

Both tables are restricted to `authenticated`, but the policy bodies are `USING (true)`. Any logged-in role can rewrite another manicurist's push endpoint or change `system_state.admin_passcode`. (This is a smaller hole than C3, but it's still write-anything inside the authenticated boundary.)

**Fix:** narrow `system_state` to a service-role-only or staff-role check. Narrow `push_subscriptions` to `manicurist_id = auth.uid()` (or whatever ID claim you carry).

### H6. Phone normalization in `send-sms` is permissive ◻
`supabase/functions/send-sms/index.ts:54–59`

Anything that isn't 10 or 11 digits is shipped to Twilio as `+<digits>`. A junk input like `to: "1"` becomes `+1`, and Twilio bills the API call regardless of whether it accepts the message.

**Fix:** validate against E.164 (`/^\+[1-9]\d{6,14}$/`) after normalization and reject 400 before calling Twilio. `libphonenumber-js` is the safer choice for non-US numbers.

---

## MEDIUM — edge cases / UX

### M1. `setInterval` in `DailySchedulePanel` re-creates itself when deps change ◻
`src/components/staff/DailySchedulePanel.tsx:241–245`

The interval is registered inside an effect with `[fetchAndDiff]` as the dep, and `fetchAndDiff` is a new function whenever `manicuristId` / `today` change. The effect *does* return a cleanup, so this isn't a strict leak — but if the manicurist switches mid-tick the in-flight fetch can race the cleanup. Worth re-reading; if you'd rather not re-create the interval, capture the deps in a ref and keep the interval stable.

### M2. Timer + clock-skew assumptions in the reducer ◻
`src/state/reducer.ts` (multiple uses of `Date.now()`)

There's no guard against the wall clock moving backwards (NTP correction, manual change). Elapsed-time and break-duration math can produce negatives that will render as `-00:42` etc. in `useElapsedTime` / `useCountdown`.

**Fix:** clamp diffs at `Math.max(0, now - start)` in the time hooks (`src/hooks/useElapsedTime.ts`, `src/hooks/useCountdown.ts`).

### M3. `Intl.DateTimeFormat` parts not null-checked in `time.ts` ◻
`src/utils/time.ts` `getTodayLA` / `getLocalDateStr`

Both build a date string by `.find()`-ing `year`/`month`/`day` parts. If any one is missing (older Safari, locale weirdness), the resulting key is `"undefined-undefined-undefined"` and *all* daily history collapses into one bucket.

**Fix:** assert each part exists and throw — better to crash loudly than silently corrupt the archive.

### M4. `localStorage` priority reads aren't shape-validated ◻
`src/utils/priorityStorage.ts` (and the readers in `AppContext.tsx:38–54`)

`JSON.parse` results are typed but not validated; a stale localStorage entry from an older schema (numbers instead of strings, missing keys) silently produces wrong sort orders downstream.

**Fix:** add a tiny `isStringArray` / `isPriorityMap` guard and fall back to defaults on shape mismatch.

### M5. `sort_order` migrations look like they fight each other ◻
`20260326120717_add_sort_order_to_salon_services.sql` then `20260326143102_fix_sort_order_by_category.sql` (~3 hours later)

The second migration replaces the values written by the first. Anyone applying the migrations to a fresh DB ends up correct; anyone who applied only the first to a long-lived DB is now out of sync with what the app expects.

**Fix:** if both have already shipped to production, leave them. For future schema work, squash within the same day or write the second one as an idempotent `UPDATE ... WHERE sort_order = <wrong-value>` rather than blanket reassignment.

### M6. `send-sms` returns Twilio error bodies verbatim ◻
`supabase/functions/send-sms/index.ts:81–91`

`details: result.message || result` leaks Twilio internals (and at minimum your Twilio response shape) to the caller. Combine with C1 and an unauthenticated attacker can probe your Twilio account.

**Fix:** `console.error(result)` server-side; return `{ error: 'Failed to send SMS' }` to the client.

---

## LOW — cleanup / smells

- **`src/components/staff/DailySchedulePanel.tsx.clean`** — leftover backup file with the same logic as `DailySchedulePanel.tsx`. Delete it; it'll only confuse future searches.
- **`src/components/register/CheckoutTicketModal.tsx`** — thin re-export wrapper documented as superseded by `TicketModal`. Migrate the imports and remove.
- **`src/utils/priority.ts`** — `getSuggestedManicurist` is exported but appears unused (replaced by `getEligibleManicurists`). Confirm with a grep then delete.
- **`src/state/AppContext.tsx:1349`** — stray `//ZZZTRASH` marker comment. Remove.
- **Garbled non-ASCII characters in toast strings** — e.g. `'Sync failed â data may not be saved. Check connection.'` in `syncCompleted` (line 1359). Looks like a mojibake'd em-dash. Fix the encoding so users see a clean message.
- **`service` columns are plain `text`** — `queue_entries.service`, `completed_services.service`, etc. A typo on insert silently splits the data set. If the values really are a fixed set, an `ENUM` (or `CHECK` constraint backed by `salon_services`) would catch this at write time.

---

## Suggested order to actually fix things

1. **Today:** rotate the admin PIN in production, then ship a migration that drops the `'072499'` default (C2). Lock down `send-sms` (C1) — auth check + origin allowlist + rate limit. Drop the anon `daily_history` policies (C3).
2. **This week:** clean the `inFlightAutoCreates` lifecycle (H1), fix the `success: true, error: …` return shape (H2), and harden `loadInitialData` error handling (H3).
3. **Next:** the appointment write chain semantics (H4), tighten authenticated RLS on `system_state` and `push_subscriptions` (H5), and the medium-severity time/clock cleanups (M2, M3).

## Caveats

- This was a static read. The "race condition" items (H4, the appointment-tombstone concern flagged in the deeper audit) are plausible from the code but I didn't reproduce them — please repro before refactoring.
- I did not run `tsc`, `eslint`, `npm audit`, or the build. If you want any of those next, say the word and I'll run them and triage the output.
