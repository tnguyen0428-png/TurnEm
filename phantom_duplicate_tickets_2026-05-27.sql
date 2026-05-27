-- Phantom duplicate-ticket investigation / cleanup
-- 2026-05-27 — addresses the bug where reconcileMissingTicketsForDate
-- spawns a phantom OPEN ticket whenever the cashier created a manual
-- "+ NEW TICKET" ticket (queue_entry_id=null), closed it at the register,
-- and the manicurist then pressed DONE on their queue card.
--
-- The two source-of-truth offenders for 2026-05-27 (Aqua Team salon):
--   Taylor       #35 closed  / #36 phantom open  (same JOE / Gel Pedicure / $50)
--   Addison V.   #6  closed  / #27 phantom open  (same BRIAN / Gel Builder+Pedi)
--
-- Both phantom tickets have been voided manually in the UI.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. AUDIT — list any other open tickets that look like phantom duplicates
--    of an already-closed ticket for the same client today. Run this first;
--    review the output before any DELETE / UPDATE.
--
--    A phantom looks like:
--      - status = 'open'
--      - There's a closed ticket today for the SAME client (phone match
--        preferred, else case-insensitive name match, excluding 'walk-in')
--      - The open one is the later of the two
-- ─────────────────────────────────────────────────────────────────────────────

WITH today AS (
  SELECT (current_date AT TIME ZONE 'America/Los_Angeles')::date AS d
)
SELECT
  open_t.id              AS phantom_ticket_id,
  open_t.ticket_number   AS phantom_num,
  open_t.client_name,
  open_t.primary_manicurist_name AS phantom_staff,
  (open_t.total_cents / 100.0) AS phantom_total,
  open_t.opened_at       AS phantom_opened,
  closed_t.id            AS canonical_ticket_id,
  closed_t.ticket_number AS canonical_num,
  closed_t.primary_manicurist_name AS canonical_staff,
  (closed_t.total_cents / 100.0)  AS canonical_total,
  closed_t.closed_at,
  open_t.queue_entry_id  AS phantom_queue_entry_id
FROM tickets open_t
JOIN today
  ON open_t.business_date = today.d
JOIN tickets closed_t
  ON closed_t.business_date = open_t.business_date
 AND closed_t.id <> open_t.id
 AND closed_t.status = 'closed'
 AND (
       (open_t.client_phone <> '' AND open_t.client_phone = closed_t.client_phone)
    OR (
         LOWER(TRIM(open_t.client_name)) = LOWER(TRIM(closed_t.client_name))
         AND LOWER(TRIM(open_t.client_name)) <> 'walk-in'
         AND TRIM(open_t.client_name) <> ''
       )
     )
WHERE open_t.status = 'open'
ORDER BY open_t.opened_at;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. RETROACTIVE LINK — for any closed ticket today whose queue_entry_id is
--    still null but whose client matches a current OPEN phantom, stamp the
--    open phantom's queue_entry_id onto the closed ticket. After this, the
--    reconcile pass (new code) will see the linkage and stop respawning.
--
--    SAFE: only updates rows where queue_entry_id IS NULL, so an existing
--    legitimate link can never be overwritten.
--
--    Skip this section if the new code (linkClosedTicketToVisit + reconcile
--    fallback) already handles every case live — kept here for the historical
--    backlog and as a recovery tool.
-- ─────────────────────────────────────────────────────────────────────────────

WITH today AS (
  SELECT (current_date AT TIME ZONE 'America/Los_Angeles')::date AS d
),
candidates AS (
  SELECT
    closed_t.id            AS closed_id,
    open_t.queue_entry_id  AS visit_id
  FROM tickets closed_t
  JOIN today ON closed_t.business_date = today.d
  JOIN tickets open_t
    ON open_t.business_date = closed_t.business_date
   AND open_t.status = 'open'
   AND open_t.queue_entry_id IS NOT NULL
   AND (
         (closed_t.client_phone <> '' AND closed_t.client_phone = open_t.client_phone)
      OR (
           LOWER(TRIM(closed_t.client_name)) = LOWER(TRIM(open_t.client_name))
           AND LOWER(TRIM(closed_t.client_name)) <> 'walk-in'
           AND TRIM(closed_t.client_name) <> ''
         )
       )
  WHERE closed_t.status = 'closed'
    AND closed_t.queue_entry_id IS NULL
)
UPDATE tickets t
SET    queue_entry_id = c.visit_id,
       updated_at      = NOW()
FROM candidates c
WHERE  t.id = c.closed_id
  AND  t.queue_entry_id IS NULL;  -- final guard against TOCTOU

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. VOID PHANTOMS (manual) — once §1 confirms which open rows are phantoms,
--    use the UI to VOID them (so the audit trail captures reason + receptionist
--    + PIN). Do NOT delete or mass-close them via SQL — that bypasses the
--    void_reason capture and the phantom ends up in revenue totals.
-- ─────────────────────────────────────────────────────────────────────────────
