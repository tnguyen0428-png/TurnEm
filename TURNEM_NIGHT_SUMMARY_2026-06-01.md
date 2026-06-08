# TurnEm — Work Summary, night of 2026-05-31 → 06-01

A record of everything diagnosed and changed tonight: what shipped, what was a
database-only change, and what's still open. Times are loose; the work ran late
into the night.

---

## TL;DR

- **Phantom duplicate ticket lines** — fixed at the root (stable `line_uid` + idempotent inserts), made the post-close case race-proof, and removed the old guards that were *silently dropping legitimate repeat services*. A daily watchdog now scans for any that slip through.
- **Phantom duplicate appointments** — found and cleaned up; they were causing false "!" flags and false "slot taken" blocks.
- **Money/closing bug** — voided-ticket payments were making the drawer look negative at close-shift. Fixed in code and cleaned up in data.
- **Gift certificates** — the redeemed number now shows on the receipt and on the ticket; balance text enlarged; confirmed voiding a ticket releases the cert.
- **Register + appointment-book UI** — walk-ins park at 8 AM instead of stacking on appointments, the "!" caution now explains itself on hover, per-line discount column removed, big calendar in the new-appointment date field, and a fit-the-whole-book view mode.
- **Git repo** — repaired a broken index at the start of the night.

> **Important operational note:** several fixes only take effect once a POS device loads the new build. **Hard-refresh every POS device and tablet (Ctrl+Shift+R)** before the next service so they're all current. A device on an old cached build is the root of several issues seen recently (void not releasing a gift cert, void leaving payments, phantoms).

---

## 1. Git index repair

The repo's Git index had been emptied (every file showed as staged-for-deletion while existing untracked on disk) — the result of a crashed Git process leaving a stale lock. Repaired with `git reset` (rebuilds the index from the last commit; touches no files). No work was lost.

## 2. Phantom duplicate ticket lines — full fix

**Root cause:** a ticket line had no stable identity. The same logical service got written by several code paths, each deriving a different `queue_entry_id`, and a misspelled status check (`'in-progress'` vs `'inProgress'`, fixed earlier on 05-31) had stopped the cleanup from ever running, so duplicates piled up.

**What shipped:**
- **`line_uid` idempotency** — every line now carries a stable id; inserts use ON CONFLICT DO NOTHING, so the same logical line written twice collapses to one. (DB column + unique index applied live; client threaded through all four insert paths.)
- **Race-proof post-close guard** — the database guard that rejects writes to a closed ticket now takes a row lock (`FOR SHARE`), closing the split-second race that let a line land right after close (the ticket #70 case).
- **Phase 2 — removed the old over-aggressive dedupe** (a trigger, an index, and a client filter) that were *silently deleting legitimate repeat services* (same service, same tech, twice) and undercharging. Now `line_uid` is the sole dedupe and real repeats stick.
- **Daily watchdog** — a scheduled task each morning (7:10 AM) scans for phantom ticket lines *and* duplicate appointments and reports anything suspicious.

**Residual (rare):** a duplicate created mid-ticket at save time with no queue link isn't auto-collapsed yet. The common cases (post-close, queue/stage) are covered. The watchdog will catch it if it ever appears; the complete fix is threading `line_uid` through the ticket modal (deferred).

## 3. What actually happened "today" (post-mortem)

All three complaints were faces of the same thing — the manicurist **queue aggressively syncs into tickets and the appointment book**, and several sync paths had bugs:
- **The duplicate-line glitch** — the misspelled status check above.
- **Turns being wrong** — partly the phantom lines inflating counts, and a genuine race where two code paths updated a tech's turn total without the safe counter (fixed 05-31 morning).
- **Appointments overlapping / unable to move** — five iterations on the appt book that day; the "urgent" fix unlocked blocks and stopped the queue sync from reverting manual moves.
- **Made worse by** the broken Git index, which made deploys unreliable, so fixes went out in fits and the same bug looked like it kept coming back.

## 4. Phantom duplicate appointments

Found duplicate appointment rows (same client + service + slot written 2–3×) from the appt-book sync churn — these caused false "!" double-booking flags and falsely blocked drag-to-move ("slot taken" when the book looked empty). Removed 5 junk rows (Alicia ×2, Sydney, Taylor, Mary), backed up first. The morning watchdog now also scans for these.

> Note: not every "!" is a phantom — two *different* clients at the same start time is a real double-booking, correctly flagged.

## 5. Register & ticket changes

- **Gift certificate # now visible** — the redeemed number was being saved on the payment but never displayed. Now printed on the receipt under the "Gift" line and shown on the on-screen ticket.
- **Gift balance text enlarged** for readability while applying a cert.
- **Per-line discount column removed** from the line grid (ticket-level Discount under the subtotal stays). Tax, Tip, and Custom were briefly removed then restored at your request.
- **Close-shift no longer counts voided-ticket payments** — that was making the drawer look short/negative. Also deleted 4 stranded payments left on old voided tickets (#29, #102, #10, #72), backed up first.
- **Confirmed:** voiding a ticket deletes its payments, which automatically returns a redeemed gift certificate's value so it can be used again. (Antonia's 05-30 case where this failed was almost certainly an old cached build that pre-dated the void-deletes-payments fix.)

## 6. Appointment book changes

- **Walk-ins park at 8 AM** with the flashing "W" when their now-slot overlaps an existing appointment, instead of stacking on top of it. The receptionist drags it to the right spot, which clears the flag. (Assignment/turn still happen immediately.)
- **The "!" caution explains itself on hover** — it now names the clashing client(s) and time, and says it's a double-booking and how to fix it.
- **New-appointment DATE field uses the big custom calendar** instead of the tiny native browser popup.
- **Fit-the-whole-book view** — in the maximized book view, the entire book (all techs + full day) now scales to fit the screen with no scrolling, even on a smaller window.

---

## Still open / next session

- **Prevent duplicate appointments at the source** — the appointment-table equivalent of the `line_uid` fix, so the book sync can't create duplicates again. (Cleanup done; prevention pending.)
- **Hana "slot taken" drag-block** — heavily split columns where the drag-block math and the visual layout disagree. Needs a concrete live repro (which tech, time, service).
- **Booking → jump book to the picked date** — let the receptionist see availability for a chosen date while booking. Needs careful cross-screen navigation work, tested live.
- **Full custom calendar for the rest of the date pickers** (optional).
- **From the prior audit, unrelated to tonight:** the send-sms function security (no auth, open CORS) and a hardcoded admin PIN default.

## Database backups created tonight (safe to drop once everything's confirmed stable)
`backup_ticket_items_20260531`, `backup_tickets_20260531`, `backup_payments_20260531`, `backup_queue_entries_20260531`, `backup_appointments_20260601`.
