/*
  # Reconcile schema drift between repo migrations and live Supabase DB

  These five columns currently exist in the production database (added manually
  via the Supabase dashboard during development) but are not declared in any
  migration file. As a result, replaying migrations against a clean Postgres
  (e.g. a Supabase preview branch or a fresh dev project) would produce a DB
  that is missing columns the application code reads and writes — silently
  breaking saves through `withRetry` (which logs but does not roll back local
  state).

  Columns reconciled here (each guarded with IF NOT EXISTS so this migration
  is a no-op against the current production DB):

    1. manicurists.time_adjustments   (jsonb,    nullable, default '{}')
       - written by syncManicurists / loadInitialData seed in AppContext.tsx
       - read by mapDbManicurist and StaffModal / assignHelpers / ManicuristPanel

    2. manicurists.pin_code           (varchar,  nullable, no default)
       - written by syncManicurists / loadInitialData seed in AppContext.tsx
       - read by StaffLoginScreen (PIN gate) and BlueprintScreen

    3. completed_services.is_appointment (boolean, NOT NULL, default false)
       - written by syncCompleted in AppContext.tsx
       - read by mapDbCompletedService for history filtering

    4. completed_services.is_requested   (boolean, NOT NULL, default false)
       - written by syncCompleted in AppContext.tsx
       - read by mapDbCompletedService for history filtering

    5. system_state.admin_passcode    (text, NOT NULL, default '072499')
       - read/written by AdminPinGate.tsx for the admin PIN gate
       - default value matches the value already seeded in production

  These types and defaults exactly match what is currently in production, so
  this migration is purely additive on a clean DB and a no-op on the live one.
*/

-- 1. manicurists.time_adjustments
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'manicurists'
      AND column_name = 'time_adjustments'
  ) THEN
    ALTER TABLE manicurists ADD COLUMN time_adjustments jsonb DEFAULT '{}'::jsonb;
  END IF;
END $$;

-- 2. manicurists.pin_code
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'manicurists'
      AND column_name = 'pin_code'
  ) THEN
    ALTER TABLE manicurists ADD COLUMN pin_code varchar;
  END IF;
END $$;

-- 3. completed_services.is_appointment
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'completed_services'
      AND column_name = 'is_appointment'
  ) THEN
    ALTER TABLE completed_services ADD COLUMN is_appointment boolean NOT NULL DEFAULT false;
  END IF;
END $$;

-- 4. completed_services.is_requested
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'completed_services'
      AND column_name = 'is_requested'
  ) THEN
    ALTER TABLE completed_services ADD COLUMN is_requested boolean NOT NULL DEFAULT false;
  END IF;
END $$;

-- 5. system_state.admin_passcode
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'system_state'
      AND column_name = 'admin_passcode'
  ) THEN
    ALTER TABLE system_state ADD COLUMN admin_passcode text NOT NULL DEFAULT '072499';
  END IF;
END $$;
