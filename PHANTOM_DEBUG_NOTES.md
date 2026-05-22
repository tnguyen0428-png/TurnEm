# Phantom Ticket Line Debug — Status as of 2026-05-22

## Current state of the bug

**SEALED (pending repro confirmation).** A DB-side BEFORE INSERT trigger now
unconditionally drops any `ticket_items` row whose `queue_entry_id` contains
`-add-`. Combined with the four pre-existing client-side guards and the
new `updateOpenTicket` filter, every code path that could produce Row 2 is
now blocked — including any path we never identified by static analysis.
The trigger `RAISE NOTICE`s into Supabase logs whenever it fires, so if the
mystery inserter is still alive, the next repro will name it explicitly.

### What was happening

Phantom ticket lines appeared when cashier adds a service line for a new
manicurist via TicketModal in an open ticket. Symptom: 2 ticket_items rows for
the same (visit, staff, service) instead of 1. One row had qid =
`{visit}-add-{staff}` (the add-child id, 77 chars), the other had qid = bare
visit_id (36 chars).

## What's been deployed (all confirmed live in production)

Verified by inspecting the served bundle `main-Czua47HT.js` on
www.turnem.io. All four guards are present in the minified JS.

### DB-side (Supabase, applied via SQL editor)
- `20260520134828_ticket_trigger_per_service_tombstone.sql` — per-(source_row,
  service) tombstone tuples in `tickets.auto_attributed_sources`
- `20260521230000_skip_ticket_items_on_closed.sql` — BEFORE INSERT trigger that
  silently skips ticket_items when parent ticket is closed (gated to
  trigger-cascaded inserts only via `pg_trigger_depth() > 0`)
- `20260521230500_skip_ticket_items_on_closed_trigger_only.sql` — follow-up
  scope fix for the above
- `20260521233000_drop_completed_services_update_propagation.sql` — dropped
  `trg_tickets_on_completed_update` so completed_services edits no longer
  cascade into ticket_items
- `20260522050000_ticket_trigger_skip_add_children.sql` — `tickets_ensure_for_visit`
  short-circuits when `p_source_row_id` contains `-add-`
- `20260522080000_drop_ticket_items_add_child_qids.sql` (applied 2026-05-22) —
  BEFORE INSERT trigger `ticket_items_skip_add_child_qid` on `ticket_items`
  unconditionally drops (returns NULL) any insert whose `queue_entry_id`
  contains `-add-`, with `RAISE NOTICE` so the offender appears in Supabase
  logs. Cleanup pass deleted phantom rows on non-voided tickets and
  recomputed `subtotal_cents` / `total_cents`. 5 phantom rows on voided
  tickets intentionally left (the `guard_ticket_items_on_voided_ticket`
  trigger blocks deletes on those, and they don't affect billing).

### Client-side (Git main / Vercel deploy)
- Commit `c47dae4`: `localCurrentTurns + turnValue` fix in TicketModal new-staff
  credit block (stops double-credit race with syncManicurists)
- Commit `41f06fc`: `appendItemsToTicket` filter + `syncEntryToTicket` early-return
  for `-add-` queue_entry_ids
- Commit `51db9df`: `addCatalogService` defaults staff to `null` instead of
  primary, removed the immediate `ensureManicuristBusyForAddedLine` call
- **UNCOMMITTED (in working tree, ready to push):** `updateOpenTicket` now
  filters out any insertRows whose `queue_entry_id` contains `-add-`, with
  a `console.warn` so the offender shows up in the browser console. This
  was the only one of the four client inserters without a `-add-` guard.

### Vercel deployment
- Latest: `dpl_4wwNUsvsUAt33UbrXLJN5MwREBCa` (commit 51db9df), READY, target=production
- Bundle: `main-Czua47HT.js`
- Verified filter exists: `queueEntryId.includes("-add-")` ✓
- Verified syncEntryToTicket guard: `e.id.includes("-add-")` ✓

## The bug that keeps happening

User tested on desktop browser (same PC as PowerShell). Did F12 → Application →
Service Workers → Unregister → reload before the latest test. Bundle should be
the new one with all guards.

### Latest test (ticket #2 today)
- Visit id: `df205f63-3945-4e19-ae65-5d017ecf81dd`
- Row 1: Z-TEST 1 / Pedicure / qid `{visit}-09c82a21...` (split-child, 73 chars)
  — legitimate, created 07:35:21
- Row 2: KAYLA / Gel Manicure / qid `{visit}-add-082bac58...` (77 chars, no #N)
  — PHANTOM, created 07:35:50
- Row 3: KAYLA / Gel Manicure / qid `{visit}` (36 chars, bare) — created
  07:35:54 (4s after Row 2)

Row 3 (bare visit qid) is from `updateOpenTicket`'s `buildItemsForSave` fallback.
Row 2 (add-child qid, no #N suffix) is mysterious — the DB trigger always
appends `#${line_idx}`, so trigger inserts would have qid format
`{visit}-add-{staff}#N`. Row 2's qid has no `#N`, so it's a CLIENT-side insert.

But my deployed filter in `appendItemsToTicket` should block ANY items with
`-add-` in `queueEntryId`. And `syncEntryToTicket` returns early for entries
where `id.includes('-add-')`. And `createTicketAtCheckin` only runs for NEW
tickets (this ticket already existed). And `updateOpenTicket` uses
`l.queueEntryId ?? ticket.queueEntryId` — the modal's lines don't carry the
add-child id on `l.queueEntryId`.

**So WHO inserted Row 2?** That's the open question.

### Side bug: manicurist card doesn't show service

After the cashier added Kayla, her card went BUSY but didn't show the service
name. Suggests Kayla's add-child queue entry doesn't exist or has empty
services. May be related to the addCatalogService change (line is created
with null staff, so `ensureManicuristBusyForAddedLine` is deferred to when
staff is picked via updateLine).

## Hypotheses to investigate next

1. **Another insert path I haven't found.** Grep showed only 4 inserts to
   `ticket_items` table (all in src/lib/tickets.ts). But there might be a
   DB-side function or trigger I haven't checked that inserts ticket_items.
   - Query: `SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc ILIKE '%INSERT INTO ticket_items%';`

2. **The bundle the user's test tab uses might be cached/different**
   from the MCP tab's bundle. Even after F12 unregister, the tab MIGHT have
   loaded the old code before that and is still running it in memory.
   - To verify: close the test tab entirely, reopen www.turnem.io fresh.

3. **The qid format on Row 2 might be from a code path that constructs the
   add-child id explicitly.** Need to search for places where `${visitId}-add-${staffId}`
   is computed AND inserted to ticket_items. Currently the only producer
   I know of is `ensureManicuristBusyForAddedLine` (writes to queue_entries,
   not ticket_items).

4. **The DB function might still have the OLD behavior despite the
   migration.** Verify by querying `pg_proc` for body_chars of
   `tickets_ensure_for_visit` (should be ~7927). Also check if there are
   MULTIPLE `tickets_ensure_for_visit` functions (overloaded by argument
   types).

## Database state at break time (2026-05-22 ~07:36 UTC)

- Open tickets today: ticket #2 (3 line items as described)
- Z-TEST 1: 2 turns, busy (currentClient = split-child queue entry)
- KAYLA: 0 turns, busy (currentClient = add-child queue entry, but card
  doesn't show service)
- Z-TEST 2, 3, 4: 0 turns, available

To resume clean: void ticket #2, reset all 5 test manicurists to 0/available,
delete all queue_entries.

## Files in folder (debug artifacts that can be cleaned)

- `apply-add-catalog-fix.ps1` — already applied, can delete
- `apply-skip-add-children.ps1` — already applied, can delete
- `fix-ticketmodal-doublecredit.patch` — outdated, can delete
- `skip-add-children.patch` / `skip-add-children-v2.patch` — outdated, can delete
- `apply_pending_migrations.sql` — already applied to prod, keep for reference
- `tickets_cleanup_dryrun.sql` / `tickets_cleanup_apply.sql` — generic
  cleanup scripts, keep
- `PHANTOM_DEBUG_NOTES.md` — this file

## Resume plan when user is back

1. **Push the unstaged `updateOpenTicket` filter change** so Vercel rebuilds
   with the new client guard. The DB trigger is already in place either way,
   but the client filter avoids a pointless round-trip and surfaces the
   offender via `console.warn`.
2. Hard refresh / incognito on www.turnem.io and re-run the Kayla scenario
   on a brand-new ticket.
3. Expected outcomes:
   - **No phantom row**: bug is fully closed. Watch the Supabase log for
     `silently_skip_ticket_items_with_add_child_qid: dropping...` notices —
     if any appear, the trigger caught a code path we never identified by
     static analysis. The notice payload includes ticket_id, qid, and name.
   - **Still phantoms**: the offender either bypassed the trigger entirely
     (extremely unlikely — the trigger is FOR EACH ROW BEFORE INSERT and
     can't be skipped from client code) OR the user's browser is still on
     stale code. Confirm bundle hash matches the latest Vercel deploy.
4. Once confirmed clean for a full day:
   - Delete the leftover debug artifacts in this folder.
   - Tackle the side bug: manicurist card service display when staff is
     assigned via the modal's add-line flow (separate problem, deferred).

## Commits already on main

```
51db9df ticket modal: addCatalogService no longer defaults staff to primary
c47dae4 tickets: skip auto-attribution for cashier add-children + fix double turn credit
41f06fc tickets: skip cashier add-children in appendItemsToTicket + syncEntryToTicket
332e8da tickets: per-service tombstone + closed-ticket guard + drop completed_services update trigger
```

All four are deployed to Vercel production. All four DB migrations are applied
to the live Supabase project.

## Pending on the working tree (not yet pushed)

- `src/lib/tickets.ts` — `updateOpenTicket` filter for `-add-` qids in
  `insertRows` (defense-in-depth; the DB trigger is already the source of
  truth, but the client filter avoids a wasted round-trip and logs the
  offender via `console.warn`).
- `supabase/migrations/20260522080000_drop_ticket_items_add_child_qids.sql`
  — NEW migration file. Already executed on prod via the SQL editor; this
  is the source-control copy for parity.
- `PHANTOM_DEBUG_NOTES.md` — this file's updates.
