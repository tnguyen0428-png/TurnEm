-- manicurist_daily_schedule: filter services per manicurist
--
-- Before: the view returned the entire appointment's `services` array to every
-- manicurist tied to the appointment, so a tech showed services that weren't
-- actually requested for them (e.g., Brian seeing a Gel Pedicure on Kelly's
-- appointment when only the Dip Only services were client-requested for him).
--
-- After: the view fans out one row per (appointment, manicurist) pair from
-- service_requests where clientRequest = true, and `services` is filtered to
-- only the services that manicurist was specifically requested for.

CREATE OR REPLACE VIEW public.manicurist_daily_schedule AS
WITH staff_requests AS (
  SELECT
    a.id              AS appointment_id,
    mid.value         AS manicurist_id,
    sr.value->>'service' AS service_name
  FROM appointments a
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(a.service_requests, '[]'::jsonb)) sr(value)
  CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(sr.value->'manicuristIds', '[]'::jsonb)) mid(value)
  WHERE (sr.value->>'clientRequest')::boolean = true
)
SELECT
  a.id,
  s.manicurist_id,
  a.date,
  a."time",
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
  true AS is_requested
FROM appointments a
JOIN staff_requests s ON s.appointment_id = a.id
GROUP BY a.id, s.manicurist_id, a.date, a."time", a.status, a.service, a.client_name, a.notes;
