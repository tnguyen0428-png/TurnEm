# TurnEm — Audit Refresh, 2026-05-25

Re-audits the codebase against the prior `TURNEM_AUDIT.md` (~May 1) and adds new findings. Same conventions:

- ✅ verified by re-reading the file in this pass
- ◻ surfaced and worth confirming before acting
- Severity is a best guess from a static read; no build/lint/run was executed

Scope: `src/`, `supabase/migrations/`, `supabase/functions/`. Repo head includes everything through commit `9c99170` (May 24).

---

## Status of prior audit items

### Critical
- **C1. `send-sms` no auth + CORS `*` + Twilio leak** — ✅ **STILL OPEN.** `supabase/functions/send-sms/index.ts` is unchanged. No auth check, `Access-Control-Allow-Origin: *` (line 4), permissive phone normalization at lines 54-59, and Twilio response leak at line 85 (`details: result.message || result`). Subsumes prior H6 and M6 too.
- **C2. Admin PIN `'072499'` hardcoded as DEFAULT** — ◻ **STILL OPEN (mitigated).** `20260424020000_reconcile_drift.sql:100` is unchanged. `20260426000001_secure_system_state.sql` tightened the RLS surface on `system_state` to `authenticated`, which reduces blast radius, but the literal PIN is still in git history and still the column default. Rotate in prod + drop the default.
- **C3. `daily_history` open `anon` RLS** — ✅ **RESOLVED.** `20260421000000_fix_rls_daily_history_authenticated.sql` (lines 13-17) drops the four anon policies and re-creates them `TO authenticated`. No further action.

### High
- **H1. `inFlightAutoCreates` never cleared** — ✅ **RESOLVED.** `src/state/AppContext.tsx:1527` adds, and lines 1569-1576 now have `try { … } finally { inFlightAutoCreates.delete(visitId); }`. Closed.
- **H2. `pushNotifications` returns `success: true` with non-null `error`** — ✅ **STILL OPEN.** `src/utils/pushNotifications.ts:198` still reads `return { success: true, error: JSON.stringify(debugInfo) };`. Any caller using the conventional `if (result.error) toast.error()` still reports a successful send as a failure. Trivial fix: rename to `debug`.
- **H3. `loadInitialData` doesn't check errors on most fetches** — ◻ **PARTIALLY FIXED.** `src/state/AppContext.tsx` lines 434-445 now destructure `staffError` and `serviceError` and check them before seeding (lines 462, 495). The other eight fetches (`queueRows`, `completedRows`, `appointmentRows`, `criteriaRows`, `calendarRows`, `dailyHistoryRows`, `scheduleRows`, `timeOffRows`, `scheduleOverrideRows`) still drop `error` on the floor. Same empty-state-clobber risk as before for those eight tables.
- **H4. `appointmentWriteChain` swallows failures and continues** — ✅ **STILL OPEN.** `src/state/AppContext.tsx:393` still reads `appointmentWriteChainRef.current.then(fn, fn).catch(…)`. The `(fn, fn)` form runs `fn` on both success and failure of the previous link, so a failed DELETE still lets a queued UPSERT proceed. This is the resurrection-bug shape the tombstone map and write-chain were jointly trying to prevent — the chain half of the defense is still neutered.
- **H5. `push_subscriptions` and `system_state` use `USING (true)`** — ✅ **STILL OPEN.** No migration narrows them. `20260426000000_create_push_subscriptions.sql:56` and `20260426000001_secure_system_state.sql:36` are still `USING (true) WITH CHECK (true)`. Inside the authenticated boundary, anyone can rewrite anyone else's push endpoint or the admin PIN.
- **H6. `send-sms` permissive phone normalization** — see C1.

### Medium
- **M1. `DailySchedulePanel` `setInterval` recreates on dep change** — ✅ **RESOLVED.** No `setInterval` in `DailySchedulePanel.tsx` anymore. (Polling moved or replaced.)
- **M2. Clock skew producing negative durations** — ✅ **RESOLVED.** `useElapsedTime.ts:13` clamps with `Math.max(0, …)`; `useCountdown.ts:19` clamps via the `isFinishingUp` guard. Closed.
- **M3. `Intl.DateTimeFormat` parts not null-checked** — ✅ **RESOLVED.** `src/utils/time.ts` lines 8-10 and 21-23 use `?? ''` fallbacks on the part lookups.
- **M4. `priorityStorage` not shape-validated** — ✅ **RESOLVED.** `src/state/AppContext.tsx` lines 39-55 (`readLocalCatPriority` / `readLocalSvcPriority`) now check `Array.isArray` / `typeof === 'object'` before trusting the parsed value.
- **M5. Conflicting `sort_order` migrations** — ◻ **STILL OPEN (historical).** Both `20260326120717_…` and `20260326143102_…` still exist. Low priority — they've already shipped — but keep in mind on the next clean DB setup.
- **M6. `send-sms` returns Twilio internals** — see C1.

### Low
- **L1. `DailySchedulePanel.tsx.clean` backup file** — ❌ **STILL PRESENT.** 384 lines of stale copy. Delete.
- **L2. `CheckoutTicketModal.tsx`** — ✅ **RESOLVED.** File is gone.
- **L3. `getSuggestedManicurist` unused** — ◻ Now used in one place (`SingleServiceAssign.tsx`). Not dead. Keep.
- **L4. `//ZZZTRASH` comment** — ❌ **STILL PRESENT.** `src/state/AppContext.tsx:1685`.
- **L5. Mojibake in toast strings** — ❌ **STILL PRESENT** at four locations in `AppContext.tsx` (lines 1416, 1700, 1746, 1853). Users still see `'Sync failed â data may not be saved.'`.
- **L6. `service` columns are plain `text`** — ◻ **STILL OPEN.** No CHECK/ENUM added in newer migrations.

---

## New findings (since the May 1 audit)

### NC1. `closeTicket` can orphan payments and leave a ticket "paid but open" ✅
`src/lib/tickets.ts:1938-1972`

Two non-transactional writes in sequence:

```ts
// 1. Insert payment rows.
const { error: pErr } = await supabase.from('payments').insert(paymentRows);
if (pErr) { … return null; }

// 2. Compute paid_cents and flip status to closed.
const { error: tErr } = await supabase
  .from('tickets')
  .update({ status: 'closed', closed_at: …, shift_id: …, paid_cents, updated_at: … })
  .eq('id', input.ticketId)
  .eq('status', 'open');
if (tErr) { console.error(…); return null; }
```

Two failure shapes, both bad:

1. **Network/timeout between the two writes.** Payments are inserted; the UPDATE never runs. The ticket stays `status='open'` with payment rows hanging off it. The cashier retries → step 1 inserts the payments *again* — now duplicated — before step 2 finally lands. Whatever picks `paid_cents` from `tickets.paid_cents` (the close path) will be correct; whatever sums `payments` (e.g. close-shift, sales report) will double-count.
2. **The `.eq('status', 'open')` predicate matches 0 rows.** A concurrent close (another tab, a stuck retry, the realtime echo flipping local state) means `tErr` is `null` but no row was updated — the function still returns `fetchTicket(...)` happily, masking the no-op. Payments are inserted against a ticket the caller did not in fact close.

**Suggested fix:** wrap both writes in an `rpc('close_ticket', …)` Postgres function so they're a single transaction. As a smaller fix, after the UPDATE check `data?.length === 0` (request `.select()` so you can) and if zero rows were affected, delete the just-inserted payments and return `null`. Right now the only thing rescuing the data on a transient failure is luck.

### NC2. `closeTicket` UPDATE result is not checked for 0 rows affected ✅
Same file as NC1, line 1956-1970. Even ignoring the orphan-payment risk above, the `.update(...).eq('id', …).eq('status', 'open')` chain has no `.select()` and no row-count check. The caller can't tell "I closed the ticket" from "the ticket was already closed and I just inserted payments against it again". Add `.select('id').single()` (or check returned `data`) and treat 0-rows as a hard error.

### NH1. `appointmentWriteChain` (H4) is still the highest-risk open item ✅
Already reflected above as H4 STILL OPEN. Flagging again because the surrounding comments at `src/state/AppContext.tsx:385-390` explicitly describe the resurrection race this chain was built to prevent — the chain only solves half of it. With `.then(fn, fn)`, a failed write doesn't halt subsequent writes, so the DELETE-then-UPSERT-reorder bug the comment block warns about can still occur if the DELETE errors. Two-character fix: `then(fn, fn)` → `then(fn)`.

### NH2. Most `loadInitialData` fetches still ignore `error` (H3 sequel) ✅
`src/state/AppContext.tsx` ~lines 430-540. Eight of the ten initial fetches still pull `data` without checking `error`. The most damaging case is `appointmentRows` and `completedRows`: an empty result from a transient timeout flows into `LOAD_STATE`, and the subsequent `syncAppointments` / `syncCompleted` round-trip is then welcome to push that empty state back. Defense-in-depth fix is the same as the original H3: bail on any non-null `error`, surface `syncError`, do not dispatch `LOAD_STATE` with partial data.

### NM1. `salon_services.price` is read straight into cents with no validation ◻
`src/state/AppContext.tsx:1500, 1789` and `src/lib/tickets.ts:551, 2064`. Pattern is `Math.round((svc?.price ?? 0) * 100)`. `salon_services.price` is a numeric column with no CHECK constraint; if a row is ever inserted with `NULL`, a negative value, or (via a typoed manual edit) `'NaN'`, the result silently becomes `0` or `NaN` cents, which then becomes the line's `unit_price_cents`. The bug is latent today because the prices in production are clean, but the codebase has no guard between the DB and the ticket math. Either add a CHECK constraint (`price >= 0`) or wrap with `Number.isFinite(svc?.price) && svc.price >= 0 ? Math.round(svc.price * 100) : <error>`.

### NM2. Name-based matching is creeping into critical paths ◻
Two recent commits introduced lookups keyed on client name where the underlying entities (appointments, completed_services, queue entries) all have stable IDs available:
- `9b50a82` — "Refresh-safe awaiting-payment lookup: match completed_services to appts by client name"
- `d190345` — "ticket close: flip ALL same-name appts whose staff is on the ticket to completed"

The "Save as Sally 2?" duplicate-name prompt (commit `5b8c9c9`) is a hint that two clients with the same first+last name *do* occur. The same-name match is the right answer 99% of the time and the wrong answer the 1% of the time it matters most (flipping the wrong appointment to `completed`, lighting up the wrong cashout). Worth re-reading both call sites and considering a fallback chain (id → phone → name) instead of pure name. Not a verified live bug, but the shape is fragile enough to flag.

### NM3. Schema churn on `tickets` suggests it is not yet stable ◻
Seven migrations touched tickets/triggers in the four days May 20-22 (per-service tombstone, skip-on-closed v1, skip-on-closed v2, drop completed-update propagation, skip-add-children at the row level, drop add-child qids, skip-add-children in the trigger function). The phantom-ticket notes in `PHANTOM_DEBUG_NOTES.md` document four client guards + a DB trigger layered on top of each other to suppress a single insert path the team still hasn't identified.

This is fine as a stabilization tactic, but it has compounded technical debt: every guard adds a place future code can be silently dropped by, and at this point a legitimate "I really do want to insert this row" may be hard to write without one of the guards eating it. Once the bug is conclusively closed (the `RAISE NOTICE` triggers will tell), consider unwinding the layered guards down to one (the DB trigger), and removing the dead `console.warn` filter paths from `tickets.ts`.

### NM4. Console noise in production code ◻
~92 `console.log/warn/debug` calls in `src/`. Heaviest: `src/lib/tickets.ts` (~40), `src/state/AppContext.tsx` (~16). Mostly low-impact debug logs from the dedup/tombstone work. Either gate them behind a `if (import.meta.env.DEV)` check or route through a single `logger` module so they can be silenced for production builds.

### NM5. Backup files / build artifacts mixed into the source tree ◻
- `src/state/AppContext.tsx.bak` (2190 lines) — full copy of `AppContext.tsx`, easy to confuse a future grep
- `src/components/shared/Modal.tsx.clean` (60 lines)
- `src/components/staff/DailySchedulePanel.tsx.clean` (384 lines, prior audit's L1, still here)
- `_trash/` — 16 `vite.config.ts.timestamp-*.mjs` files; this is the Vite dev-server artifact dir. Add `_trash/` to `.gitignore` and remove from git.

### NM6. Repo root is cluttered with one-shot deploy scripts ◻
~27 files in the root that look like ad-hoc tooling, not source:
- 23 `.bat` (PUSH_NOW.bat, push-*-fix.bat, deploy.bat, …)
- 2 `.ps1` (apply-add-catalog-fix.ps1, apply-skip-add-children.ps1)
- 3 root `.sql` (apply_pending_migrations.sql, tickets_cleanup_apply.sql, tickets_cleanup_dryrun.sql)
- 3 `.patch` files (fix-ticketmodal-doublecredit.patch, skip-add-children.patch, skip-add-children-v2.patch)
- ~7 GoDaddy / AQUA policy HTML/TXT pasteables

`PHANTOM_DEBUG_NOTES.md:138-147` already lists most of these as "debug artifacts that can be cleaned." Cleanup safe to do whenever the phantom bug is confirmed closed.

### NL1. Duplicate `formatTime` ◻
`src/utils/time.ts:48` and `src/components/blueprint/reportShared.tsx:117` are functionally identical (one uses `toLocaleTimeString`, the other `Intl.DateTimeFormat`). Pick one. Two implementations is the kind of thing that drifts the day someone fixes a bug in one but not the other.

### NL2. Magic timing constants scattered through code ◻
- `setTimeout(…, 1500)` for saved-status fade in `AppContext.tsx:338`
- `8000` ms auth fallback in `AuthContext.tsx:28`
- `1000` ms clock ticks in `hooks/sharedClock.ts`
- `7s` polling cadence referenced only in comments in `DailySchedulePanel.tsx`

Move to `src/constants/timings.ts` so the cadence story is in one place and tests/repros can reuse the names.

### NL3. Sizing of the three monoliths (informational) ◻
`src/lib/tickets.ts` (2603), `src/components/register/TicketModal.tsx` (2581), `src/state/AppContext.tsx` (2190). Not flagging as "must split now," but at this size each one is the kind of file where a careful bug fix takes longer to read than to write, and concurrent edits from two people across a week of work merge poorly. The natural splits the search pass suggested:
- `tickets.ts` → `ticketMappers.ts`, `ticketLifecycle.ts`, `ticketUtils.ts`
- `TicketModal.tsx` → `useTicketForm.ts`, `TicketItemsTable.tsx`, `PaymentSection.tsx`
- `AppContext.tsx` → per-table sync modules (`syncQueue.ts`, `syncCompleted.ts`, `syncStaff.ts`) with the provider becoming a shell

Worth doing once the active TicketModal/ticket-trigger churn quiets down.

---

## What I checked that came up clean

- No empty `catch (e) {}` blocks in `src/`.
- No `@ts-ignore` / `@ts-expect-error`.
- Only 10 `: any` annotations in source (most in comments or one `(r: any)` map cast in `StaffPortalScreen.tsx`).
- Only one `supabase` client (`src/lib/supabase.ts`); imported consistently.
- `src/types/index.ts` is the canonical type source; types are not redefined ad-hoc throughout.

---

## Suggested order of attack

**Now (under an hour each):**
1. **H2 fix** — rename `error` → `debug` in `pushNotifications.ts:198`. Update the one or two callers. Two-line change.
2. **H4 fix** — `then(fn, fn)` → `then(fn)` in `AppContext.tsx:393`. Decide whether to bubble the error or absorb it with a `syncError` toast. Re-read the tombstone interaction once after the change.
3. **L1/L4/L5/NM5/NM6 cleanup pass** — delete `DailySchedulePanel.tsx.clean`, `AppContext.tsx.bak`, `Modal.tsx.clean`, `_trash/`, the ZZZTRASH comment, fix the mojibake in the four sync toasts, move root `.bat`/`.ps1`/`.patch`/`.sql` into a `scripts/` directory (or delete the obsolete ones per `PHANTOM_DEBUG_NOTES.md`).

**This week:**
4. **NC1 + NC2** — make `closeTicket` actually atomic, or at minimum delete-payments-on-update-failure and detect 0-rows-affected. This is the highest-impact unverified item: the failure mode is silent and produces duplicate revenue under retry. Repro by killing the network between `payments.insert` and `tickets.update` and walking the resulting state.
5. **C1** — auth + origin allowlist + rate limit + E.164 validation on `send-sms`.
6. **C2** — rotate prod PIN, ship a migration dropping the default.
7. **H3 / NH2** — error-check the remaining eight fetches in `loadInitialData`.
8. **H5** — narrow `push_subscriptions` to `manicurist_id = auth.uid()` and `system_state` to a service-role / staff-role check.

**When the phantom-ticket bug is conclusively closed:**
9. **NM3 cleanup** — unwind the four client-side guards in `tickets.ts` down to one (the DB trigger). Remove the dead `console.warn` defenders.
10. **NM4** — gate or strip the 92 `console.*` calls.
11. **NL3** — split the three monoliths.

---

## Caveats

- Static read again, no runtime/tsc/eslint. NC1 and H4 are the two items where I'd really like to see a manual repro before refactoring — the failure mode is conditional on the network/concurrency state and a code-only review can't prove either is currently hitting prod.
- The bug-hunt pass surfaced an "off-by-one" claim around queue_entry_id `#N` numbering and a "100x price" claim around the TicketModal blur handler. I re-read both and neither held up — `appendItemsToTicket` and `createTicketAtCheckin` both number from `#1`, and the blur path only round-trips dollars. Dropping both. (Noting for the record so you don't go looking for them.)
- I did not run `tsc`, `eslint`, `npm audit`, or `npm run build`. Say the word and I'll do that pass and triage the output.
