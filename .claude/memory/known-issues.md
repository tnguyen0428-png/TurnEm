# Known Issues & Fixes
_Last updated: 2026-05-12_

## AppContext.tsx Null Byte Corruption
- **Symptom:** Sync errors appear on every state change; `grep -c "" AppContext.tsx` shows it's a binary file
- **Cause:** File operations (GIT_INDEX_FILE workaround, append operations) leave null bytes at end of file
- **Fix:** `python3 -c "open('file','wb').write(open('file','rb').read().replace(b'\x00',b''))"`
- **Prevention:** After any Python file writes, verify with `grep -c ""` before committing

## Git index.lock Stale Lock
- **Symptom:** `fatal: Unable to create '.git/index.lock': File exists`
- **Cause:** Previous git process crashed, lock file can't be deleted (Windows filesystem permissions)
- **Fix:** Use `GIT_INDEX_FILE=/tmp/alt-index git add ...` then `git commit-tree` + `git update-ref`

## break_start_time Type Mismatch
- **Symptom:** Every manicurist sync fails with Supabase error
- **Cause:** DB column is `bigint` (milliseconds) but code was sending ISO timestamp string
- **Fix:** Send `m.breakStartTime ?? null` (raw number), read back with `Number(row.break_start_time)`
- **Status:** Fixed as of 2026-04-23

## Vercel Static File Routing
- **Symptom:** Images (webp, gif) return HTML instead of the file
- **Cause:** SPA rewrite rule catches all paths including static assets
- **Fix:** Add file extensions to exclusion regex in vercel.json: `(?!assets|.*\\.webp|.*\\.gif|.*\\.png|.*\\.jpg)`
- **Status:** Fixed as of 2026-04-23

## Staff Portal Showing Stale Status
- **Cause 1:** PWA cache — user needs to hard refresh or reinstall
- **Cause 2:** Sync failing (manicurist upsert error) so DB not updated
- **Cause 3:** Was sending 20+ individual upserts; now batched into one call

## Duplicate Break Timer
- **Symptom:** Two break timers showing on manicurist card
- **Cause:** Same JSX block copy-pasted twice in ManicuristCard.tsx
- **Status:** Fixed 2026-04-23

## LLM-editor truncation across many files (2026-05-12)
- **Symptom:** Build fails with "Unterminated string literal", "JSX element X has no corresponding closing tag", or "'}' expected" — usually at the very END of a file, with the file literally cut off mid-line.
- **Cause:** An LLM editor (Claude/Cursor/etc.) ran out of tokens while writing the file and saved a truncated version. Sometimes a `.bak` file is left behind from a prior round of the same issue.
- **Detection:** `wc -l` the file vs `git show HEAD:<path> | wc -l` — a much shorter current file is a strong signal. `tail -3 <file> | cat -A` also reveals mid-line cutoffs (no trailing `$`).
- **Fix:** Splice the missing tail back from HEAD: `{ sed -n '1,Np' current; git show HEAD:file | sed -n 'M,$p'; } > /tmp/recovered && cp /tmp/recovered file` where N is the last clean line in current and M is the first line in HEAD's version that contains the same content.
- **Files seen this episode:** tickets.ts, TicketModal.tsx, GiftCardSaleModal.tsx, RegisterScreen.tsx, StaffModal.tsx, BlueprintScreen.tsx, AppContext.tsx — all in one batch.
- **Prevention:** Run `npx tsc --noEmit` immediately after any large LLM edit; check that the file ends with the expected closing brace before moving on.

## Mount-vs-host file desync via bash redirect appends (2026-05-12)
- **Symptom:** Vite/esbuild errors point at line numbers BEYOND what the file actually has on the mount; typecheck passes in the sandbox but the dev server keeps showing the same error.
- **Cause:** `cat >> file` or `cp file file` via the Linux sandbox mount of the Windows folder can leave the HOST file with extra appended content that the mount itself doesn't show. The mount reads cleanly while the host file has duplicate content.
- **Detection:** Use the Read tool (Windows host path, e.g. `C:\Users\ethan\TurnEmApp\src\lib\tickets.ts`) — it goes through the Windows API directly and will reveal duplicate content the bash mount hides.
- **Fix:** Use the Edit tool (host path) to delete the duplicated trailing block. Bash appends to the mount can compound the problem.
- **Prevention:** Prefer Read/Write/Edit (host paths) over bash `cat >>` for any file on the mounted Windows folder. If using bash, follow up with a host-path Read to verify what actually landed on disk.

## Stale Vite/HMR error overlay
- **Symptom:** Red error overlay shows a syntax error referencing line numbers that don't match the actual file content. Pressing Esc dismisses it but it reappears.
- **Cause:** Vite cached the parse result from when the file was actually broken. HMR didn't pick up the subsequent fix, OR the user's npm run dev is in a stale state.
- **Fix:** `Ctrl+C` the dev server, run `npm run dev` again, hard refresh the browser (`Ctrl+Shift+R`).
- **When it's NOT stale:** If a clean restart still shows the error, run `findstr /n "<unique-text>" <file>` in Windows to confirm what's actually on disk.

## Realtime publication missing tables (2026-05-13)
- **Symptom:** Staff portal (and any other surface) feels frozen — first load shows correct data, but no updates flow when something changes on another device. The frontend subscribes via `supabase.channel(...).on('postgres_changes', { table: ... })` and never receives anything.
- **Cause:** `supabase_realtime` publication only included `customers`. Every other postgres_changes subscription was silently listening to events that were never broadcast.
- **Detection:** `SELECT tablename FROM pg_publication_tables WHERE pubname='supabase_realtime' ORDER BY tablename;` — should list every live-ops table.
- **Fix:** `ALTER PUBLICATION supabase_realtime ADD TABLE <table>;` — applied via migration `realtime_publication_all_live_tables`.
- **Prevention:** Whenever the frontend adds a new postgres_changes subscription, also add the table to the publication. Easy thing to forget.

## Auto-trigger duplicates from same source row (2026-05-13)
- **Symptom:** Ticket items appear duplicated on closed tickets — same service, same staff, two lines. paid_cents stays correct but subtotal_cents inflates.
- **Cause:** The first version of the `tickets_ensure_for_visit` Postgres trigger appended items every time it fired, with `queue_entry_id = source_row_id` for every line. Re-fires (UPDATE echoes, multiple events) added duplicates. Worse, on a single completed_services row carrying multiple services, all lines collided on `(ticket_id, queue_entry_id)` and only the FIRST service got in.
- **Fix (current trigger):**
  1. Skip if `tickets.status != 'open'` (closed/voided are untouchable).
  2. Skip if `source_row_id` is already in `tickets.auto_attributed_sources`.
  3. Use per-line key `${source_row_id}#${idx}` for ticket_items.queue_entry_id so N services in one row produce N distinct lines.
  4. Per-service same-name-staff guard so the trigger doesn't duplicate what older client code already inserted (with NULL queue_entry_id).
- **Cleanup pattern when this recurs:** look for ticket_items pairs where one has NULL qe and another has a non-NULL qe with the same name + staff; the trigger-inserted one is the dupe.

## COMPLETE_SERVICE with empty client.services (2026-05-13)
- **Symptom:** History page shows a manicurist row for a client but with NO service name (the service pill is missing).
- **Cause:** Reducer wrote `client.services` directly into the completed_services row. When a SPLIT_AND_ASSIGN child ended up with an empty services array (multi-service distribution put all services on siblings, or a later edit cleared it), the completed_services row was persisted with `services=[]`.
- **Fix:** In COMPLETE_SERVICE reducer, fall back to the names in `client.serviceRequests` filtered to the completing manicurist when `client.services` is empty.
- **First seen:** Candace × Tammy on ticket #70 (2026-05-13). Tammy's completed_services row had `services=[]`; the ticket had her line correctly (Pedicure $40).

## Blueprint dual-PIN gate (2026-05-13)
- Blueprint now accepts EITHER the system admin PIN (system_state.admin_passcode) for full access OR any receptionist's personal PIN for Customer-Profiles-only access. Tier stored in `accessTier` state in BlueprintScreen.
- If you need to add new sidebar groups, remember to keep `CUSTOMERS` group always visible at the receptionist tier — that's the only one filtered IN, everything else filtered OUT.

## Multi-device assignment missing tickets (2026-05-13)
- **Symptom:** Clients assigned/completed on one device's queue UI don't get tickets created — they're missing from Register.
- **Cause:** AppContext's sync effect short-circuits with `if (wasRemote) return;` before `syncQueue` (which contains the ticket auto-create call) runs. Assignments arriving via realtime from another device skipped the ticket-create path.
- **Fix:** Server-side trigger on `queue_entries` / `completed_services` (see turnem-app.md). The frontend reconcile path (RegisterScreen.useEffect) and AppContext.syncQueue paths are now belt-and-suspenders, with the DB trigger as primary.
