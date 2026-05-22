-- TurnEm — Ticket Phantom / Duplicate Line Audit (DRY RUN)
-- =========================================================
-- Run each section against the TurnEM Salon Supabase project in the SQL Editor.
-- NOTHING here mutates data. Apply-step DELETE/UPDATEs live in the second file
-- (tickets_cleanup_apply.sql) and are commented out so they require a
-- deliberate uncomment + run.
--
-- Patterns covered:
--   A. Same-source duplicate ticket lines (the cancel/reassign + split race)
--   B. Phantom lines on CLOSED tickets        (today's migration motivator)
--   C. Phantom lines on VOIDED tickets        (sibling of B)
--   D. Zero-item PAID tickets                 (Rosie/Kim symptom on 5/21)
--   E. Subtotal/total drift                   (smoke test for hidden phantoms)
--   F. Duplicate OPEN tickets per visit       (DB unique index should prevent)
--   G. Old OPEN tickets                       (housekeeping inventory)
--
-- Notes on schema:
--   - ticket_items.queue_entry_id is set by the trigger / app to either
--       <source_row_id>           for bare lines
--       <source_row_id>#<n>       for in-batch collisions or per-service
--                                 splits added by the trigger
--     We collapse to the bare form using split_part(..., '#', 1).
--   - tickets.auto_attributed_sources stores tombstone tuples
--       <source_row>::<service_name>
--     Lines whose tuple is missing on the parent ticket are the most
--     likely phantom-resurrection candidates.
--
-- The Supabase SQL Editor runs one statement at a time — paste each
-- section in turn, or run the whole file via psql.

-- =========================================================
-- A. Same-(source, service, staff) duplicate ticket lines
-- =========================================================
-- For every (ticket_id, source_row, name, staff1_id) where more than one
-- ticket_items row exists, list all the rows. The "keep" column is the
-- canonical line the apply step would retain:
--   1. line whose queue_entry_id has no `#` suffix (the bare form), else
--   2. lowest sort_order, else
--   3. lowest id.

WITH normalized AS (
  SELECT
    ti.id,
    ti.ticket_id,
    ti.name,
    ti.staff1_id,
    ti.staff1_name,
    ti.queue_entry_id,
    split_part(COALESCE(ti.queue_entry_id, ''), '#', 1) AS source_row,
    ti.sort_order,
    ti.unit_price_cents,
    ti.ext_price_cents,
    ti.created_at
  FROM ticket_items ti
  WHERE ti.queue_entry_id IS NOT NULL
    AND ti.queue_entry_id <> ''
),
grouped AS (
  SELECT
    ticket_id,
    source_row,
    name,
    staff1_id,
    COUNT(*) AS dup_count
  FROM normalized
  GROUP BY ticket_id, source_row, name, staff1_id
  HAVING COUNT(*) > 1
)
SELECT
  t.ticket_number,
  t.business_date,
  t.status                                        AS ticket_status,
  t.client_name,
  n.source_row,
  n.name                                          AS service,
  n.staff1_name,
  n.dup_count_total                               AS lines_for_this_combo,
  n.id                                            AS ticket_item_id,
  n.queue_entry_id                                AS line_qid,
  n.sort_order,
  n.created_at,
  (n.queue_entry_id NOT LIKE '%#%')               AS is_bare_qid,
  CASE
    WHEN n.id = n.keeper_id THEN 'KEEP'
    ELSE 'DELETE'
  END                                             AS verdict
FROM (
  SELECT
    normalized.*,
    grouped.dup_count                             AS dup_count_total,
    FIRST_VALUE(normalized.id) OVER (
      PARTITION BY normalized.ticket_id, normalized.source_row, normalized.name, normalized.staff1_id
      ORDER BY
        (normalized.queue_entry_id NOT LIKE '%#%') DESC,  -- prefer bare qid
        normalized.sort_order ASC,
        normalized.created_at ASC,
        normalized.id ASC
    ) AS keeper_id
  FROM normalized
  JOIN grouped USING (ticket_id, source_row, name, staff1_id)
) n
JOIN tickets t ON t.id = n.ticket_id
ORDER BY t.business_date DESC, t.ticket_number DESC, n.source_row, n.name, n.staff1_name, verdict, n.sort_order;


-- =========================================================
-- B. Phantom lines inserted AFTER a ticket was CLOSED
-- =========================================================
-- These are the textbook "ghost line on a closed ticket" rows. After the
-- 5/21 trigger fixes (skip_ticket_items_on_closed + dropping the
-- completed_services update propagation) the rate of new occurrences
-- should fall to zero, but rows created BEFORE today's migration are
-- still in the DB.

SELECT
  t.ticket_number,
  t.business_date,
  t.client_name,
  t.status,
  t.closed_at,
  ti.id                                AS ticket_item_id,
  ti.name                              AS service,
  ti.staff1_name,
  ti.queue_entry_id                    AS line_qid,
  ti.unit_price_cents,
  ti.ext_price_cents,
  ti.created_at                        AS line_created_at,
  EXTRACT(EPOCH FROM (ti.created_at - t.closed_at))::int AS seconds_after_close
FROM ticket_items ti
JOIN tickets t ON t.id = ti.ticket_id
WHERE t.status = 'closed'
  AND t.closed_at IS NOT NULL
  AND ti.created_at > t.closed_at + INTERVAL '5 seconds'  -- small grace window
ORDER BY t.business_date DESC, t.ticket_number DESC, ti.created_at;


-- =========================================================
-- C. Phantom lines on VOIDED tickets
-- =========================================================
-- A BEFORE INSERT trigger (guard_ticket_items_on_voided_ticket) is
-- supposed to RAISE for these. Anything matching here predates that
-- guard or slipped through under load.

SELECT
  t.ticket_number,
  t.business_date,
  t.client_name,
  t.status,
  t.void_reason,
  ti.id                                AS ticket_item_id,
  ti.name                              AS service,
  ti.staff1_name,
  ti.queue_entry_id                    AS line_qid,
  ti.unit_price_cents,
  ti.ext_price_cents,
  ti.created_at                        AS line_created_at
FROM ticket_items ti
JOIN tickets t ON t.id = ti.ticket_id
WHERE t.status = 'voided'
ORDER BY t.business_date DESC, t.ticket_number DESC, ti.created_at;


-- =========================================================
-- D. Closed tickets with payments but ZERO ticket_items
-- =========================================================
-- The exact symptom that drove migration 20260521230500
-- (skip_ticket_items_on_closed_trigger_only). The fix prevents NEW
-- occurrences. Any rows here are pre-fix and still showing $X paid but
-- a blank SERVICES column in Register/History.

SELECT
  t.id                                 AS ticket_id,
  t.ticket_number,
  t.business_date,
  t.client_name,
  t.status,
  t.paid_cents,
  t.total_cents,
  t.closed_at,
  COALESCE(p.payment_count, 0)         AS payment_count,
  COALESCE(p.payment_total, 0)         AS payment_total_cents
FROM tickets t
LEFT JOIN (
  SELECT ticket_id,
         COUNT(*)              AS payment_count,
         SUM(amount_cents)     AS payment_total
  FROM payments
  GROUP BY ticket_id
) p ON p.ticket_id = t.id
LEFT JOIN ticket_items ti ON ti.ticket_id = t.id
WHERE t.status = 'closed'
GROUP BY t.id, t.ticket_number, t.business_date, t.client_name, t.status,
         t.paid_cents, t.total_cents, t.closed_at,
         p.payment_count, p.payment_total
HAVING COUNT(ti.id) = 0
   AND (t.paid_cents > 0 OR COALESCE(p.payment_total, 0) > 0)
ORDER BY t.business_date DESC, t.ticket_number DESC;


-- =========================================================
-- E. Subtotal/total drift between ticket header and items
-- =========================================================
-- ticket.subtotal_cents should equal SUM(ticket_items.ext_price_cents).
-- A mismatch means either a phantom line that hasn't been folded into
-- totals, or a real line that was deleted without recomputing.

SELECT
  t.id                                 AS ticket_id,
  t.ticket_number,
  t.business_date,
  t.client_name,
  t.status,
  t.subtotal_cents                     AS header_subtotal,
  COALESCE(SUM(ti.ext_price_cents), 0) AS items_subtotal,
  t.subtotal_cents - COALESCE(SUM(ti.ext_price_cents), 0) AS drift_cents,
  COUNT(ti.id)                         AS line_count
FROM tickets t
LEFT JOIN ticket_items ti ON ti.ticket_id = t.id
GROUP BY t.id, t.ticket_number, t.business_date, t.client_name, t.status, t.subtotal_cents
HAVING t.subtotal_cents <> COALESCE(SUM(ti.ext_price_cents), 0)
ORDER BY ABS(t.subtotal_cents - COALESCE(SUM(ti.ext_price_cents), 0)) DESC,
         t.business_date DESC, t.ticket_number DESC;


-- =========================================================
-- F. Two OPEN tickets for the same visit (queue_entry_id)
-- =========================================================
-- The partial unique index uniq_tickets_queue_entry_id should make this
-- impossible. If it returns rows, the index is missing or the data
-- predates it.

SELECT
  queue_entry_id,
  COUNT(*)                                          AS open_tickets,
  array_agg(ticket_number ORDER BY opened_at DESC)  AS ticket_numbers,
  array_agg(id ORDER BY opened_at DESC)             AS ticket_ids,
  array_agg(opened_at ORDER BY opened_at DESC)      AS opened_ats
FROM tickets
WHERE status = 'open'
  AND queue_entry_id IS NOT NULL
  AND queue_entry_id <> ''
GROUP BY queue_entry_id
HAVING COUNT(*) > 1
ORDER BY COUNT(*) DESC;


-- =========================================================
-- G. Stale OPEN tickets (housekeeping inventory)
-- =========================================================
-- Lists every OPEN ticket whose business_date isn't the current LA date.
-- No verdict — review and decide per-ticket whether to close / void.

SELECT
  t.id                                 AS ticket_id,
  t.ticket_number,
  t.business_date,
  t.client_name,
  t.primary_manicurist_name,
  t.subtotal_cents,
  t.total_cents,
  t.paid_cents,
  t.opened_at,
  COUNT(ti.id)                         AS line_count,
  COALESCE(SUM(p.amount_cents), 0)     AS payments_total
FROM tickets t
LEFT JOIN ticket_items ti ON ti.ticket_id = t.id
LEFT JOIN payments p ON p.ticket_id = t.id
WHERE t.status = 'open'
  AND t.business_date <
      (NOW() AT TIME ZONE 'America/Los_Angeles')::date
GROUP BY t.id
ORDER BY t.business_date ASC, t.ticket_number ASC;
