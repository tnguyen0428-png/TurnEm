/*
  # Add services array columns to queue_entries and completed_services

  1. Modified Tables
    - `queue_entries`
      - Add `services` (text[], not null, default '{}') - array of service names for multi-service support
    - `completed_services`
      - Add `services` (text[], not null, default '{}') - array of service names for multi-service support

  2. Data Migration
    - Copies existing single `service` value into the new `services` array column

  3. Important Notes
    - The original `service` column is kept for backward compatibility
    - The new `services` column is the source of truth going forward
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'queue_entries' AND column_name = 'services'
  ) THEN
    ALTER TABLE queue_entries ADD COLUMN services text[] NOT NULL DEFAULT '{}';
  END IF;
END $$;

UPDATE queue_entries SET services = ARRAY[service] WHERE services = '{}' AND service IS NOT NULL AND service != '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'completed_services' AND column_name = 'services'
  ) THEN
    ALTER TABLE completed_services ADD COLUMN services text[] NOT NULL DEFAULT '{}';
  END IF;
END $$;

UPDATE completed_services SET services = ARRAY[service] WHERE services = '{}' AND service IS NOT NULL AND service != '';
