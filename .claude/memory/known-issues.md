# Known Issues & Fixes
_Last updated: 2026-04-23_

## AppContext.tsx Null Byte Corruption
- **Symptom:** Sync errors appear on every state change; `grep -c "" AppContext.tsx` shows it's a binary file
- **Cause:** File operations (GIT_INDEX_FILE workaround, append operations) leave null bytes at end of file
- **Fix:** `python3 -c "open('file','wb').write(open('file','rb').read().replace(b'\\x00',b''))"`
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
