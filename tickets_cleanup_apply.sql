-- TurnEm — Ticket Phantom / Duplicate Line Cleanup (APPLY)
-- =========================================================
-- DO NOT RUN BLIND. Run the dry-run report (tickets_cleanup_dryrun.sql)
-- first, eyeball the rows, then come back here.
--
-- Each section is wrapped in its own BEGIN; ... ROLLBACK; block so you can
-- run it as-is to see "would have deleted N rows", then flip ROLLBACK -> COMMIT
-- when you're satisfied.
--
-- Sections mirror the dry-run report (A, B, C, D, E, G).
-- F is excluded — duplicate open tickets per visit are rare enough that the
-- right move is hand-inspection in the dry-run, not a scripted merge.
--
-- Recommended order: A, B, C, D, then re-run E (drift) to recompute totals.
-- The Supabase SQL Editor runs one statement at a time. Paste each
-- BEGIN ... ROLLBACK; block individually, look at the counts it
-- returned, and only then change ROLLBACK -> COMMIT and re-run.


-- ─────────────────────────────────────────────────────────
-- A. Delete same-(source, service, staff) duplicate lines
-- ─────────────────────────────────────────────────────────
BEGIN;

WITH normalized AS (
  SELECT
    ti.id,
    ti.ticket_id,
    ti.name,
    ti.staff1_id,
    ti.queue_entry_id,
    ti.sort_order,
    ti.created_at,
    split_part(COALESCE(ti.queue_entry_id, ''), '#', 1) AS source_row
  FROM ticket_items ti
  WHERE ti.queue_entry_id IS NOT NULL
    AND ti.queue_entry_id <> ''
),
ranked AS (
  SELECT
    id,
    ticket_id,
    ROW_NUMBER() OVER (
      PARTITION BY ticket_id, source_row, name, staff1_id
      ORDER BY
        (queue_entry_id NOT LIKE '%#%') DESC,
        sort_order ASC,
        created_at ASC,
        id ASC
    ) AS rn
  FROM normalized
),
to_delete AS (
  SELECT id, ticket_id FROM ranked WHERE rn > 1
),
deleted AS (
  DELETE FROM ticket_items WHERE id IN (SELECT id FROM to_delete)
  RETURNING ticket_id
)
SELECT COUNT(*) AS rows_deleted, COUNT(DISTINCT ticket_id) AS tickets_touched
FROM deleted;

-- Flip the line below from ROLLBACK to COMMIT to make it stick.
ROLLBACK;
-- COMMIT;


-- ─────────────────────────────────────────────────────────
-- B. Delete phantom lines on CLOSED tickets
-- ─────────────────────────────────────────────────────────
-- Removes ticket_items.created_at > tickets.closed_at + 5s.
-- 5s grace covers the legitimate "close commit / last item commit"
-- ordering jitter at checkout.
BEGIN;

WITH deleted AS (
  DELETE FROM ticket_items ti
  USING tickets t
  WHERE t.id = ti.ticket_id
    AND t.status = 'closed'
    AND t.closed_at IS NOT NULL
    AND ti.created_at > t.closed_at + INTERVAL '5 seconds'
  RETURNING ti.ticket_id, ti.name, ti.staff1_name, ti.ext_price_cents
)
SELECT COUNT(*) AS rows_deleted,
       COUNT(DISTINCT ticket_id) AS tickets_touched,
       SUM(ext_price_cents) AS dollars_freed_cents
FROM deleted;

ROLLBACK;
-- COMMIT;


-- ─────────────────────────────────────────────────────────
-- C. Delete phantom lines on VOIDED tickets
-- ─────────────────────────────────────────────────────────
-- Voided tickets should not carry line items. If they do, they're
-- pre-guard leftovers — purge.
BEGIN;

WITH deleted AS (
  DELETE FROM ticket_items ti
  USING tickets t
  WHERE t.id = ti.ticket_id
    AND t.status = 'voided'
  RETURNING ti.ticket_id
)
SELECT COUNT(*) AS rows_deleted, COUNT(DISTINCT ticket_id) AS tickets_touched
FROM deleted;

ROLLBACK;
-- COMMIT;


-- ─────────────────────────────────────────────────────────
-- D. Zero-item PAID closed tickets — VOID + flag
-- ─────────────────────────────────────────────────────────
-- These are the Rosie/Kim ghosts: ticket header says paid, but the
-- service lines were silently dropped by the trigger pre-fix. They
-- can't be restored from this side (we don't know what services the
-- cashier was editing into them). The right move is to mark them
-- VOID with an audit note so they stop appearing as "real" closed
-- tickets in reports. Payments are KEPT so the cash reconciliation
-- still adds up — refund decisions are a manual call.
--
-- Comment this block out and reconstruct manually from receipts if
-- you'd rather not auto-void.
BEGIN;

WITH targets AS (
  SELECT t.id, t.ticket_number, t.business_date, t.client_name
  FROM tickets t
  LEFT JOIN ticket_items ti ON ti.ticket_id = t.id
  WHERE t.status = 'closed'
    AND t.paid_cents > 0
  GROUP BY t.id, t.ticket_number, t.business_date, t.client_name
  HAVING COUNT(ti.id) = 0
),
updated AS (
  UPDATE tickets
  SET status = 'voided',
      void_reason = 'auto-void: closed with payment but zero line items (phantom-trigger casualty pre-5/21 fix)',
      updated_at = NOW()
  WHERE id IN (SELECT id FROM targets)
  RETURNING id, ticket_number, business_date, client_name
)
SELECT * FROM updated ORDER BY business_date DESC, ticket_number DESC;

ROLLBACK;
-- COMMIT;


-- ─────────────────────────────────────────────────────────
-- E. Recompute subtotal/total drift
-- ─────────────────────────────────────────────────────────
-- After A/B/C delete lines, header totals on the affected tickets are
-- stale. Recompute from the surviving items. This is safe to run on
-- its own at any time — it only updates tickets where the current
-- header doesn't match the items.
BEGIN;

WITH items_sum AS (
  SELECT
    t.id AS ticket_id,
    COALESCE(SUM(ti.ext_price_cents), 0) AS items_subtotal
  FROM tickets t
  LEFT JOIN ticket_items ti ON ti.ticket_id = t.id
  GROUP BY t.id
),
drift AS (
  SELECT
    t.id,
    t.subtotal_cents AS old_subtotal,
    s.items_subtotal AS new_subtotal,
    GREATEST(
      0,
      s.items_subtotal
        - COALESCE(t.discount_cents, 0)
        + COALESCE(t.tax_cents, 0)
        + COALESCE(t.tip_cents, 0)
    ) AS new_total,
    t.total_cents AS old_total,
    t.status
  FROM tickets t
  JOIN items_sum s ON s.ticket_id = t.id
  WHERE t.subtotal_cents <> s.items_subtotal
),
updated AS (
  UPDATE tickets
  SET subtotal_cents = drift.new_subtotal,
      total_cents = drift.new_total,
      updated_at = NOW()
  FROM drift
  WHERE tickets.id = drift.id
  RETURNING tickets.id, drift.old_subtotal, drift.new_subtotal,
            drift.old_total, drift.new_total, drift.status
)
SELECT * FROM updated ORDER BY status, ABS(new_subtotal - old_subtotal) DESC;

ROLLBACK;
-- COMMIT;


-- ─────────────────────────────────────────────────────────
-- G. (Optional) Close stale OPEN tickets older than today
-- ─────────────────────────────────────────────────────────
-- Hands-off-by-default. Uncomment the UPDATE only after eyeballing the
-- dry-run G result. The action below VOIDS open tickets whose
-- business_date is before today AND that carry no payments. Anything
-- with payments stays open for manual review.

-- BEGIN;
--
-- WITH targets AS (
--   SELECT t.id, t.ticket_number, t.business_date, t.client_name
--   FROM tickets t
--   LEFT JOIN payments p ON p.ticket_id = t.id
--   WHERE t.status = 'open'
--     AND t.business_date < (NOW() AT TIME ZONE 'America/Los_Angeles')::date
--   GROUP BY t.id, t.ticket_number, t.business_date, t.client_name
--   HAVING COUNT(p.id) = 0
-- )
-- UPDATE tickets
-- SET status = 'voided',
--     void_reason = 'auto-void: stale open ticket from previous business day, no payments',
--     updated_at = NOW()
-- WHERE id IN (SELECT id FROM targets)
-- RETURNING ticket_number, business_date, client_name;
--
-- ROLLBACK;
-- -- COMMIT;
