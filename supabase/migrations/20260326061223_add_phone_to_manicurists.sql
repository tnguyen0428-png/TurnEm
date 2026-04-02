/*
  # Add phone number to manicurists

  1. Modified Tables
    - `manicurists`
      - Added `phone` (text, nullable) - manicurist's phone number for SMS notifications

  2. Notes
    - Phone number is optional so existing records are unaffected
    - Used for sending SMS turn alerts when a client is assigned
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'manicurists' AND column_name = 'phone'
  ) THEN
    ALTER TABLE manicurists ADD COLUMN phone text;
  END IF;
END $$;