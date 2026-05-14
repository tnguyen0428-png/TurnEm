# TurnEmApp — Project Context
_Last updated: 2026-05-13_

## Stack
- React + TypeScript + Vite (dual entry: index.html + staff.html)
- Supabase (Postgres) for real-time state sync — project: `cpgiqgyfoqlczpvbwfic` ("TurnEM Salon")
- Tailwind CSS, Lucide icons, font-bebas for headings
- Deployed on Vercel at turnem.io

## Key Files
- `src/state/AppContext.tsx` — central state, Supabase sync functions (frequently corrupted by null bytes — check with `grep -c "" file` if sync breaks)
- `src/state/reducer.ts` — all app actions. COMPLETE_SERVICE now falls back to `client.serviceRequests` for the completing staff when `client.services` is empty, so split-and-assign rows can't silently produce a completed_services row with `services=[]`.
- `src/components/queue/ManicuristCard.tsx` — main queue card
- `src/components/staff/StaffPortalScreen.tsx` — staff-facing portal. Now subscribes to manicurists/queue_entries/completed_services/salon_services/appointments AND tickets/ticket_items. Today's services list shows customer first name + dollar amount (sourced from real ticket_items by visit_id + staff1_id, not catalog).
- `src/components/register/RegisterScreen.tsx` — register tab; loads tickets first then reconciles in a background effect (do NOT block paint on reconcile)
- `src/components/register/CloseShiftScreen.tsx` — close-shift surface. Now: editable transactions in main tabs → "CONTINUE TO CLOSE" → Sales Validation popup with sub-tabs Payment Summary / Sales Validation / Reports & Overnight (Bank Deposit removed) → CONFIRM CLOSING dialog ("Do you want to close shift?") → actually closes.
- `src/components/blueprint/BlueprintScreen.tsx` — Blueprint now has a dual-PIN gate. Admin PIN → full access; any receptionist's personal PIN → restricted to Customer Profiles only. Tier tracked in `accessTier` state; nav and renderContent filter on it.
- `src/lib/tickets.ts` — tickets data layer; `reconcileMissingTicketsForDate` uses an in-memory phone/name Map to avoid per-iteration Supabase round trips. `updatePayment` adjusts an existing payment's amount, recomputes cash change, and re-derives the ticket's paid_cents.
- `public/lunch-break.webp` — break animation shown on staff portal
- `vercel.json` — SPA rewrite rules (must exclude static assets like .webp, .gif, .png)

## Architecture Notes
- Staff portal is read-only (isStaffMode blocks sync-back to DB), polls Supabase independently
- Manicurists synced as a single batch upsert (not per-row) to avoid 20+ individual calls
- `withRetry` wrapper on all Supabase writes (3 retries, 2s delay)
- `break_start_time` stored as bigint (milliseconds) in DB — send as Number(), not ISO string
- Git has a stale index.lock issue; use `GIT_INDEX_FILE=/tmp/alt-index` workaround if needed
- Register reconcile (sweep completed services → create/append tickets) runs in a background `useEffect`, not on the critical path. Don't move it back inline.

## Ticket Auto-Creation Triggers (server-side, 2026-05-13)
Tickets are now auto-created in Postgres so client-side gaps (e.g. wasRemote skips in syncQueue) can't leave a visit without a ticket.

Triggers on `queue_entries` (INSERT + UPDATE) and `completed_services` (INSERT + UPDATE):
- Call `tickets_ensure_for_visit(visit_id, business_date, client_name, manicurist_id, opened_at, services[], source_row_id)`
- Visit id = leading UUID of the row id (`tickets_visit_id` helper). Split children share the parent UUID, so all siblings land on one ticket.
- Per-line key: `ticket_items.queue_entry_id = ${source_row_id}#${idx}` (NOT the raw source id) — required because a single row can carry multiple services and the partial unique index `(ticket_id, queue_entry_id)` would otherwise drop the 2nd+ services.

Three guards:
1. **Hard stop on non-open tickets** — closed/voided tickets are never modified.
2. **Audit array** `tickets.auto_attributed_sources text[]` — every source row id the trigger has attributed is recorded. Re-fires skip immediately, so cashier-deleted lines aren't resurrected.
3. **Same-name-staff dedupe** — if a line with the same service name + staff already exists (any qe, including NULL), skip. Covers legacy client-code lines and prevents trigger/client dueling.

## supabase_realtime Publication (2026-05-13)
**CRITICAL:** the publication previously only included `customers`. All other postgres_changes subscriptions in the app were dead. Fixed by adding: manicurists, queue_entries, completed_services, appointments, salon_services, turn_criteria, calendar_days, staff_schedules, staff_time_off, system_state, tickets, ticket_items, payments, shifts, shift_movements, daily_history.

When adding a new table the frontend will subscribe to, also `ALTER PUBLICATION supabase_realtime ADD TABLE <name>;`.

## Register module (src/components/register/)
- `RegisterScreen.tsx` — list view with sort (time/total/number/client/staff)
- `TicketModal.tsx` — single-ticket open/close/void flow with line-item editor
- `CloseShiftScreen.tsx` — close-shift with editable transactions + Sales Validation popup + confirm dialog
- `OpenShiftModal.tsx` — bills-only opening cash count
- `GiftCardSaleModal.tsx` — gift cert sale; allocates serial from `nextGiftCardSerial`
- `MoneyCountTable.tsx` — shared denomination grid (props: hideCoins, billsAscending, hideTotal)
- `ReceptionistClockModal.tsx` — clock in/out picker, writes to local clockLog ledger

## Supabase Schema Notes
- `manicurists.break_start_time` = bigint (milliseconds), NOT timestamptz
- `queue_entries.extra_time_ms` = integer
- `tickets.auto_attributed_sources` = text[] DEFAULT '{}' — used by the trigger as the per-source audit array
- Partial unique index `uniq_ticket_items_per_entry` on `(ticket_id, queue_entry_id) WHERE queue_entry_id IS NOT NULL`
- Partial unique index `uniq_tickets_queue_entry_id` on `(queue_entry_id) WHERE queue_entry_id IS NOT NULL`
- RLS: permissive policies for both anon and authenticated roles on all tables

## Deployment
- GitHub repo: https://github.com/tnguyen0428-png/TurnEm.git (HTTPS, uses stored credentials)
- Vercel auto-deploys on push to main
- vercel.json rewrites: static files (.webp, .gif, .png, .jpg, assets) must be excluded from SPA rewrite

## Staff
- Manicurists have IDs like `mani-1` through `mani-18` (pre-seeded)
- Kayla has UUID id `082bac58-fa58-41dd-87ca-094ee095836b` (added via app)
- Tammy = mani-3 (referenced in the Candace × Tammy History fix)
