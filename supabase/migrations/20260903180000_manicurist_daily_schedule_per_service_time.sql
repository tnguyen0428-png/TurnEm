-- manicurist_daily_schedule: show each tech the time THEY start THAT service
--
-- Before: the view fanned out one row per (appointment, manicurist) from
-- service_requests, and `services` was correctly filtered to that manicurist
-- (see 20260514140000). But `time` was still taken from the appointment
-- HEADER — a."time" — which belongs to the appointment's primary tech.
--
-- A second tech on the same booking therefore saw the FIRST tech's clock.
-- Julie Falk, 2026-09-03: one appointment, Gel Pedicure with LEO at 10:45
-- (the header) and Gel Builder with CHRISTINA at 10:00. CHRISTINA's portal
-- said 10:45 — 45 minutes late for a client already in the chair. Over the
-- 30 days to 2026-09-03 there were 78 entries where a tech was shown a LATER
-- time than reality (avg 49 min, worst 195 min), the direction that makes a
-- tech read as free when she is not.
--
-- After: the entry's own `startTime` is carried through the CTE and becomes
-- `time`. Where an entry has no startTime the header is still the best
-- available answer, so it is used as a fallback — that is not a rare path:
-- 184 of 1,226 request entries in that window (15%) carry no startTime.
--
-- Grouping now keys on the effective start time, so a tech with two services
-- at DIFFERENT times on one appointment gets one row per time (Tony's rule:
-- each tech sees the time they start that service). A tech with two services
-- that share a time still collapses into a single row, unchanged.
--
-- New column `entry_key` uniquely identifies a row. `id` deliberately stays
-- the appointment id so anything reading it still means "the appointment";
-- callers must key lists and diffs on entry_key, which is no longer 1:1 with
-- id. Appended last because CREATE OR REPLACE VIEW may add columns only at
-- the end.
--
-- Rollback: re-apply 20260514140000_manicurist_daily_schedule_per_request.sql.
-- No appointment data is read differently or written by this change.

CREATE OR REPLACE VIEW public.manicurist_daily_schedule AS
WITH staff_requests AS (
  SELECT
    a.id                 AS appointment_id,
    mid.value            AS manicurist_id,
    sr.value->>'service' AS service_name,
    -- The tech's own start time for this service; the appointment header only
    -- when the entry does not carry one.
    COALESCE(NULLIF(btrim(sr.value->>'startTime'), ''), a."time") AS start_time
  FROM appointments a
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(a.service_requests, '[]'::jsonb)) sr(value)
  CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(sr.value->'manicuristIds', '[]'::jsonb)) mid(value)
  WHERE (sr.value->>'clientRequest')::boolean = true
)
SELECT
  a.id,
  s.manicurist_id,
  a.date,
  s.start_time AS "time",
  a.status,
  a.service,
  to_jsonb(array_agg(s.service_name ORDER BY s.service_name)) AS services,
  CASE
    WHEN a.client_name IS NULL OR btrim(a.client_name) = ''::text THEN 'Client'::text
    WHEN lower(btrim(a.client_name)) = 'walk-in'::text THEN 'Walk-in'::text
    WHEN array_length(regexp_split_to_array(btrim(a.client_name), '\s+'::text), 1) = 1 THEN btrim(a.client_name)
    ELSE ((split_part(btrim(a.client_name), ' '::text, 1) || ' '::text) ||
          upper(left((regexp_split_to_array(btrim(a.client_name), '\s+'::text))[array_length(regexp_split_to_array(btrim(a.client_name), '\s+'::text), 1)], 1))) || '.'::text
  END AS display_name,
  (a.notes IS NOT NULL AND btrim(a.notes) <> ''::text) AS has_notes,
  true AS is_requested,
  (a.id || '@' || s.manicurist_id || '@' || COALESCE(s.start_time, '')) AS entry_key
FROM appointments a
JOIN staff_requests s ON s.appointment_id = a.id
GROUP BY a.id, s.manicurist_id, a.date, s.start_time, a.status, a.service, a.client_name, a.notes;
