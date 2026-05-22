# Appt Book Flow — Keep-In-Book Refactor (WIP)
_Saved 2026-05-21 — pick up tonight_

## Goal
After hitting "Q" on an appointment, the block should REMAIN visible in the appointment book (it used to disappear). Color tracks the queue-entry lifecycle:

- **Scheduled** → normal palette (`apptPalette`)
- **Waiting in queue** → light gray (bg `#f3f4f6`, border `#9ca3af`)
- **In service** (linked queue entry `status === 'inProgress'`) → gray (bg `#d1d5db`, border `#6b7280`, text `#374151`)
- **Checked out** (`appt.status === 'completed'`) → black (bg `#1f2937`, white text, border `#111827`)

The plain `checked-in` state (set manually without a linked queue entry) keeps its existing green.

## Status
Code changes are in place across 4 files. **Not tested locally yet.** Run `npm run dev` tonight and verify end-to-end. The Cowork sandbox bash was a stale snapshot (May 17) so typecheck couldn't be run from there.

## Files Changed

### `src/components/appointments/AppointmentBookView.tsx`
1. Replaced the `queuedApptIds` "safety net" hide-filter (was around line 209) with a `queueByApptId` Map (useMemo) that maps `originalAppointment.id → QueueEntry`. The `dayAppts` filter no longer hides queued appts.
2. `addApptToQueue` (~line 710): swapped `DELETE_APPOINTMENT` for `UPDATE_APPOINTMENT` with `status: 'checked-in'`. Queue-entry creation below is unchanged (still snapshots `originalAppointment`).
3. Block renderer (~line 1000+): added `linkedQ`, `isCheckedOut`, `isInService`, `isWaitingQ`, `isCheckedIn`, plus `textColor` and `subTextColor`. New 5-way ternary for `bg`/`border`. Existing inline text-color expressions now use `textColor`/`subTextColor`. Kept `isCompleted = isCheckedOut` alias so older nearby branches still work.
4. `isLocked` now includes `isCheckedOut || isInService || isWaitingQ || hasRequest` — block can't be dragged while in any queue-lifecycle state.
5. Hover action row (Q / edit / delete-service / cancel) is hidden when `isCheckedOut || isInService || isWaitingQ`.

### `src/components/appointments/AppointmentsScreen.tsx`
- `handleCheckIn` (~line 111): same change as `addApptToQueue` — `DELETE_APPOINTMENT` → `UPDATE_APPOINTMENT` with `status: 'checked-in'`. Queue-entry creation below is unchanged.

### `src/components/queue/WaitingPanel.tsx`
- `handleRevertToAppt`: if `entry.originalAppointment` exists AND `state.appointments.find(a.id === ...)` finds the live row, `UPDATE_APPOINTMENT` it back to `status: 'scheduled'` (no new id, no duplicate row). Falls back to the legacy `ADD_APPOINTMENT` path for old queue entries where the appt was actually deleted.

### `src/state/reducer.ts` — `COMPLETE_SERVICE`
- After computing `nextCompleted`, also computes `nextAppointments` mapping the linked appt (`client.originalAppointment?.id`) to `status: 'completed'`. Returned alongside `queue/manicurists/completed`. No-op when there's no linked appt (walk-ins).

## Test Plan (for tonight)
1. `npm run typecheck` — confirm no NEW TS errors. Pre-existing errors in `printReceipt.ts` / `RegisterScreen.tsx` from the May 12 LLM-truncation issue may still be there; ignore those (see `.claude/memory/known-issues.md`).
2. `npm run dev`. In the browser:
   - Scheduled appt → click **Q** → block stays visible, turns **light gray**.
   - Assign the queue client to a tech → book block turns **gray**.
   - Complete service / checkout → block turns **black** with white text.
   - **Revert** on the queue card while still queued → block returns to scheduled colors. Confirm: only ONE row remains in the book (no duplicate).
   - Try `handleCheckIn` from `AppointmentsScreen` (the list view) — same color progression should apply.

## Open Questions / Things to Watch
- **Sync echo to Supabase.** The change from DELETE to UPDATE on Q should flow through the existing `UPDATE_APPOINTMENT` sync path in `AppContext.tsx`. Watch for any sync errors after Q'ing.
- **Color palette.** Tailwind-ish neutrals — easy to adjust in `AppointmentBookView.tsx` ~lines 1015–1031 if shades look off.
- **Other deletion points.** Confirmed the two `DELETE_APPOINTMENT`-on-Q callsites (book view + appts screen). Did NOT audit modal flows for other places that might delete the appt during queueing.
- **Multi-day view / past dates.** Didn't check how yesterday's checked-out (now black) appts look on the calendar / history screens.

## Rollback
```
git checkout HEAD -- src/components/appointments/AppointmentBookView.tsx \
                     src/components/appointments/AppointmentsScreen.tsx \
                     src/components/queue/WaitingPanel.tsx \
                     src/state/reducer.ts
```
