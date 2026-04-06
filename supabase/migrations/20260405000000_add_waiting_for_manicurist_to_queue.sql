DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'queue_entries' AND column_name = 'waiting_for_manicurist_id'
  ) THEN
    ALTER TABLE queue_entries ADD COLUMN waiting_for_manicurist_id text DEFAULT NULL;
  END IF;
END $$;
