# TurnEm — Audit, 2026-05-31

Six days after the May 25 two-pass audit. 27 commits have landed since, and the May 25 "audit fixes" commit (`30ed4f6`) explicitly addressed NC1, H2, H4, P2H2, P2M2, P2M4, mojibake, ZZZTRASH, and the .bak/.clean files.

Conventions: ✅ verified against the file, ◻ worth a manual check, ❌ refuted (so it doesn't get re-litigated). No build/lint/run executed.

---

## Status of prior open findings

| Item | What it was | Status |
|---|---|---|
| **NC1** closeTicket atomicity | payments insert then `tickets` UPDATE in sequence, no rollback | ✅ **FIXED** — `tickets.ts:2133-2175` now does `.select('id')`, checks `updatedTickets.length === 0`, rolls back inserted payments on either DB error or zero-rows match, logs orphan ids if rollback itself fails. NC1 + NC2 can be closed. |
| **H2** pushNotifications return shape | `{ success: true, error: ... }` | ✅ Closed by `30ed4f6`. |
| **H4** appointmentWriteChain `then(fn, fn)` | failed link let next link run | ✅ Closed by `30ed4f6`. |
| **P2H2** reconcileAppts missing `withRetry` | bare fetch on tab-focus | ✅ Closed by `30ed4f6`. |
| **P2L1** reconcileAppts silently overwriting local appts | full-replace LOAD_STATE on tab-focus | ✅ Closed by commit `40d264f` (May 28) — "stop tab-focus reconcileAppts from silently deleting live appointments". |
| **P2M2** withRetry retries permanent 4xx | | ✅ Closed by `30ed4f6`. |
| **P2M4** nightly-save-history mints new `id` | upsert payload included `id` | ✅ Closed by `30ed4f6`. |
| **L5** mojibake in sync toasts | em-dash render bug | ✅ Closed by `30ed4f6`. |
| **L4** ZZZTRASH comment | | ✅ Closed by `30ed4f6`. |
| **C1** send-sms unauth + CORS `*` + Twilio leak | | ❌ **STILL OPEN.** Unchanged since May 25. |
| **C2** admin PIN `'072499'` as column DEFAULT | | ❌ **STILL OPEN.** Unchanged. |
| **H3 / NH2** loadInitialData ignoring `error` on 8 fetches | | ❌ **STILL OPEN.** Unchanged. |
| **H5 / P2H1** permissive RLS (`USING (true)` or `auth.uid() IS NOT NULL`) on `system_state`, `push_subscriptions`, and the POS tables `tickets / ticket_items / payments / shifts / shift_movements` | | ❌ **STILL OPEN.** No staff-role migration yet. Still the largest open structural risk. |
| **L1** `DailySchedulePanel.tsx.clean` | stale backup | ◻ Not re-checked this pass. |
| **NM6** ~27 ad-hoc scripts in repo root | | ❌ Largely **STILL PRESENT.** New ones added since May 25 (see N31‑L1). |

---

## New findings (since 2026‑05‑25)

### CRITICAL — none

The two prior C-items (C1 send-sms, C2 admin PIN) are still the only Critical-tier opens. Nothing this pass surfaced reached that bar.

---

### HIGH

#### N31‑H1. `voidTicket` proceeds even when payment-delete fails — exact reincarnation of the bug the fix was meant to solve ✅
`src/lib/tickets.ts:2358-2362`

The fix landed on May 29 (`9b7fd26 fix(void): delete attached payments when voiding a ticket`) with this header comment (lines 2342-2354):

> Without this, the close-shift Sales Validation popup surfaces a non-zero Error equal to SUM(payments) over voided tickets. … Observed 2026-05-29 close-shift: tickets #29 ($107 visa) and #102 ($40 visa) both voided with payment rows intact -> Sales Validation Error +$147.

The delete itself is correct, but the error handling is `console.warn` and continue:

```ts
const { error: payDelErr } = await supabase
  .from('payments')
  .delete()
  .eq('ticket_id', ticketId);
if (payDelErr) {
  console.warn('[tickets] voidTicket payments delete:', payDelErr.message);
}
// …function continues and returns true.
```

Any transient delete failure (network blip, RLS denial once roles wire in, a 409 from a stale row version) leaves the ticket marked `voided` with the payment rows intact — i.e. the exact close-shift `+$147` Sales Validation Error this commit set out to prevent. The comment claims idempotency ("a second void call re-runs this delete") but the cashier has no UI cue that a retry is needed.

**Fix:** if `payDelErr` is non-null, return `false` before flipping ticket status, and surface a toast so the cashier knows to retry the void. (Alternatively wrap both writes in an RPC for true atomicity.)

#### N31‑H2. `TicketModal` bucket-recompute updates `total_turns` with a plain read-modify-write, bypassing the existing CAS helper ✅
`src/components/register/TicketModal.tsx:1336-1364`

`tickets.ts` already exports `applyTurnDelta` (line 2486), explicitly documented as compare-and-swap for exactly this reason — see the JSDoc:

> Without this guard the previous code did SELECT → UPDATE as two statements, which loses any concurrent write (syncManicurists, voidTicket rollback, a parallel reallocate call) that lands between them.

But the bucket-recompute path added in commit `c185b65` (May 27) reads `manicurists.total_turns` with `.maybeSingle()` and writes back with `.eq('id', mid)` only — no `.eq('total_turns', cur)` guard, no retry loop. Any concurrent write to that manicurist (another tab's bucket-recompute, the realtime echo from `voidTicket`, a `syncManicurists` round-trip) is silently clobbered by the stale snapshot. This is the same loss-of-update race `applyTurnDelta` was built to prevent.

**Fix:** replace the inline read-modify-write block with `await applyTurnDelta(entry.manicuristId, turnDelta);`. Roughly a ten-line delete.

#### N31‑H3. `voidTicket`'s own total_turns rollback also bypasses `applyTurnDelta` ✅
`src/lib/tickets.ts:2410-2425`

Same shape as N31‑H2, inside `voidTicket` (same file as the CAS helper). The rollback loop reads `total_turns`, computes `Math.max(0, cur - delta)`, writes back unguarded. A void that races with a checkout (another tab recomputing buckets per N31‑H2) or with a second void of an overlapping visit can silently clobber the other writer.

**Fix:** `await applyTurnDelta(mid, -delta);` — replaces the inner read-write block.

#### N31‑H4. `AppointmentModal` DONE handler swallows customer-write errors (notes + profile silently dropped) ✅
`src/components/modals/AppointmentModal.tsx:1556-1581`

```ts
for (const appt of r.pendingAppts) dispatch({ type: 'ADD_APPOINTMENT', appointment: appt });
void (async () => {
  const cid = await upsertCustomerFromIntake(...);
  if (cid && c.permanentNote) {
    await supabase.from('customers').update({ notes: c.notes, updated_at: ... }).eq('id', cid);
  }
})();
setRecap(null);
handleClose();
```

The appointment dispatch is synchronous and the appointments do get persisted — so this is *not* "appointment lost" as the exploration pass framed it. What *is* dropped silently:

1. The customer profile upsert (if `upsertCustomerFromIntake` rejects).
2. The permanent-note write to `customers.notes`.

Both are fired with `void (async () => …)()`, no `.catch`, no error toast. The receptionist sees the booking land on the book and assumes the note + profile saved; on the next visit they discover neither did.

**Fix:** await the async block before `handleClose()` (or chain `.catch(err => { dispatch(toast('Customer save failed')); })`). The appointment dispatch is fine to leave optimistic.

---

### MEDIUM

#### N31‑M1. Standing-appointment series has no upper bound on generated rows ◻
`src/components/modals/AppointmentModal.tsx` standing-appts loop (introduced `8af0ae7`, refined `3af421c`)

The receptionist sets `interval_days` and `standingEndDate`; the loop generates one appointment per qualifying date inside that window. There's no UI cap and no warning when the window is large. A typo on the end date (`2026` → `2036`) or a one-day interval would generate hundreds-to-thousands of rows, every one of which dispatches `ADD_APPOINTMENT` and rides the sync chain. Database fine; the React tree and the UPSERT batch are not.

**Fix:** clamp `standingEndDate − today` to ≤ 180 days in the form validator; show "Creating N appointments" in the recap so the receptionist sees blast radius before pressing DONE; refuse to render the recap if N > 52.

#### N31‑M2. `syncAppointments` upsert has no `.select()` / row-count check ✅
`src/state/AppContext.tsx:2039-2040`

```ts
const { error } = await withRetry(() => supabase.from('appointments').upsert(changed, { onConflict: 'id' }));
if (error) { … onError('Sync failed — data may not be saved. Check connection.'); }
```

A `0 rows affected` outcome (a row that the server already considers deleted, an RLS deny that responds as no-op rather than error, a clock-skew predicate miss) returns success here. Local state then carries an appointment that the server doesn't have, and the next reconcile won't re-create it. Same shape as the closeTicket NC2 case before it was fixed.

**Fix:** add `.select('id')`, treat `data.length !== changed.length` as a non-fatal sync warning, log the diff.

#### N31‑M3. Repo-root git index corruption artifacts left in place ✅
`.git/index.bak` (Apr 26), `.git/index.corrupt-1777363650`, `.git/index.corrupt-1777363657` (both Apr 28)

`git status` and `git ls-files` against this checkout report `error: index uses p^?x extension, which we do not understand; fatal: index file corrupt`. The live `.git/index` (May 29) is currently usable for `git log` / `git ls-tree` but not for index-touching commands, and the three corruption backups suggest unresolved past failures. Cloning the repo elsewhere inherits a clean index (the backups live only in the local working `.git/`), but day-to-day work on this machine is fragile — half the deploy `.bat` scripts run `git add / commit / push`, and they'll fail or behave unpredictably as long as the index is in this state.

**Fix:** `git read-tree HEAD` to rebuild the index from HEAD (the working tree itself is fine), then `rm .git/index.bak .git/index.corrupt-*`. If that fails to rebuild a usable index, the safest path is a fresh `git clone` of the GitHub repo into a sibling folder and copying over uncommitted changes by hand.

#### N31‑M4. New phantom/turn-drift fixes are not under any test ◻
`bb2c9da`, `48b38c1`, `7d4e011`, `c185b65` (May 27‑29)

The cluster of fixes around totalTurns convergence, walk-in resynth, bucket-welding on multi-staff, and merge phantom-line suppression are all subtle invariant-preservation logic and all landed without an accompanying test file (`src/__tests__` does not exist; `package.json` has no `test` script). Each one is now load-bearing for either close-shift correctness or daily turn fairness — i.e. exactly the kind of code where the next regression will be silently introduced and only noticed at end-of-day reconciliation.

**Fix:** at minimum, add a single Vitest harness that exercises the pure-state-math helpers (`applyTurnDelta` logic, `convergeTotalTurns`, the bucket-recompute function pulled out of `TicketModal` as a pure function) with the published before/after scenarios from `PHANTOM_DEBUG_NOTES.md` as fixtures. Don't aim for full coverage — just guard the documented regressions.

---

### LOW

#### N31‑L1. Repo root is *more* cluttered than at May 25, not less ✅
Files added since prior audit (per directory listing, May 31):
`APPT_BOOK_EMERGENCY.html` (May 30), additional patch/sql artifacts, `phantom_duplicate_tickets_2026-05-27.sql`.

Prior audit's NM6 list is essentially intact (~27 root-level `.bat / .ps1 / .patch / .sql / .html` ad-hoc files). The recommendation is unchanged: move into `scripts/` and `_archive/` directories, delete the ones whose patches are already committed (the `.patch` and `apply-*.ps1` family).

#### N31‑L2. `PENDING_DEPLOY.md` is stale ✅
File dated April 28 still lists the manicurist Daily Schedule pill + push notifications as pending. Those shipped May 30 (`aef99ae`). Delete the file (already `.gitignore`d so removal won't be re-tracked), or convert to a real CHANGELOG.md going forward.

#### N31‑L3. send-sms still uses CORS `*` and no auth (C1 carryover, called out separately because Twilio launch is approaching) ✅
`supabase/functions/send-sms/index.ts` — unchanged since May 25. If the SMS launch is on the near horizon, this should jump to Critical the moment the function gets called from real client code with a real phone number on the other end.

---

## What was checked and came up clean

- **NC1 closeTicket fix:** verified at `tickets.ts:2125-2175`. `.select('id')`, zero-rows check, payment rollback on either DB error or zero-row match, orphan-id logging if rollback itself fails. ✅
- **P2H2 reconcileAppts withRetry + P2L1 silent overwrite:** verified at `AppContext.tsx:420-463`. `withRetry`-wrapped fetch, tombstone check, diff before LOAD_STATE. ✅
- **applyTurnDelta CAS helper:** verified at `tickets.ts:2486-2530`. Properly bounded retry, clamped at 0, returns boolean. The helper is correct; the issue (per N31‑H2/H3) is that two callers don't use it.

---

## Refuted (so no one chases them)

- ❌ **`.env` is committed to git.** Checked via `git ls-tree -r HEAD` and `git log --all -- .env`. The file is listed in `.gitignore:23`, has never been added to a tracked tree, and no commit added or modified it. The local `.env` exists on disk (correctly) but is not in the repo.
- ❌ **`closeTicket` still has the orphan-payments race (NC1 not actually fixed).** It is fixed — see the verified-clean section.
- ❌ **Two-tab concurrent appointment edit causes data loss.** Speculative; the `wasRemote` flag + `lastEditedAt` ordering does enough to make this no-worse than every other field in the system. Adding optimistic locking is a future improvement, not a current bug.
- ❌ **Mobile price sync (3abd65a) overwrites cashier edits without merge.** Could not be traced to specific code; the commit added price echoing to staff portal, not a write-back path. Drop unless evidence shows up.

---

## Suggested order of attack

**Today (each well under an hour):**
1. **N31‑H1** — return `false` and toast when `payDelErr` is non-null in `voidTicket`. Five-line change. Closes the exact regression class this commit was meant to fix.
2. **N31‑H2 + N31‑H3** — swap the two read-modify-write blocks for `applyTurnDelta(...)` calls. ~15 lines deleted total.
3. **N31‑H4** — wrap the DONE-handler customer write in try/catch and surface a toast on failure.
4. **N31‑M3** — `git read-tree HEAD`, remove the three corruption backup files, confirm `git status` works. The deploy `.bat` scripts depend on it.

**This week:**
5. **N31‑M1** — cap standing-appointment series length and show a count in the recap.
6. **N31‑M2** — `.select()`-and-count `syncAppointments` upserts.
7. **C1** — auth + origin allowlist + E.164 validation on `send-sms`, before SMS launches.
8. **C2** — rotate prod PIN, drop the column DEFAULT in a migration.

**When the phantom-ticket bug is conclusively closed:**
9. **N31‑M4** — pull bucket-recompute and `convergeTotalTurns` into pure helpers and add a Vitest harness around the documented regressions.
10. **N31‑L1 + NM6** — root-folder cleanup (`scripts/` + `_archive/`).
11. **P2H1 / H5** — staff-roles RLS migration. Large; needs a design pass.

---

## Caveats

- Static read only — no `tsc`, no `eslint`, no `npm run build`, no runtime. N31‑H1/H2/H3 are the items where I'd most like to see a manual repro before refactoring; the failure mode is conditional on network/concurrency state and a code-only review can't prove any of them is currently hitting prod.
- Git index on this checkout is corrupt; the index couldn't be queried directly. All file-existence and history claims above used the working tree and the object database (`git ls-tree`, `git log`), which are unaffected.
