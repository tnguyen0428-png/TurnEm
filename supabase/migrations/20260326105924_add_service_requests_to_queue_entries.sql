/*
  # Add service_requests column to queue_entries

  1. Modified Tables
    - `queue_entries`
      - Add `service_requests` (jsonb, not null, default '[]') - array of {service, manicuristId} objects
        allowing clients to request different manicurists for different services

  2. Important Notes
    - Existing rows default to empty array
    - The existing requested_manicurist_id and is_requested columns are kept for backward compatibility
    - The new column stores an array like: [{"service":"Manicure","manicuristId":"uuid"}, {"service":"Pedicure","manicuristId":null}]
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'queue_entries' AND column_name = 'service_requests'
  ) THEN
    ALTER TABLE queue_entries ADD COLUMN service_requests jsonb NOT NULL DEFAULT '[]'::jsonb;
  END IF;
END $$;