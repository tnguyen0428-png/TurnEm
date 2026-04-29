-- POS Phase 1 — Register foundation.
--
-- Tables:
--   tickets             — one per client visit; lifecycle open → closed
--   ticket_items        — line items with primary + secondary staff and price
--   payments            — one row per tender on a ticket; refunds reference origin
--   shifts              — drawer session for the day, with starting cash + close balance
--   shift_movements     — pay-in / pay-out events on a shift
--
-- Money is stored as integer cents. RLS is permissive (any authenticated
-- user) at this phase; manager-gated paths land with the staff-roles wiring
-- in a later migration.
--
-- Note on FK types: external tables (manicurists / queue_entries / appointments
-- / completed_services / salon_services) store id as text, so the foreign
-- keys here use text. New tables introduced in this migration use uuid for
-- their own primary keys.

CREATE TABLE IF NOT EXISTS tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number integer NOT NULL,
  business_date date NOT NULL,
  queue_entry_id text REFERENCES queue_entries(id) ON DELETE SET NULL,
  appointment_id text REFERENCES appointments(id) ON DELETE SET NULL,
  completed_service_id text REFERENCES completed_services(id) ON DELETE SET NULL,
  shift_id uuid,
  client_name text NOT NULL DEFAULT 'Walk-in',
  client_phone text NOT NULL DEFAULT '',
  client_email text NOT NULL DEFAULT '',
  primary_manicurist_id text REFERENCES manicurists(id) ON DELETE SET NULL,
  primary_manicurist_name text NOT NULL DEFAULT '',
  primary_manicurist_color text NOT NULL DEFAULT '#9ca3af',
  subtotal_cents integer NOT NULL DEFAULT 0,
  discount_cents integer NOT NULL DEFAULT 0,
  tax_cents integer NOT NULL DEFAULT 0,
  tip_cents integer NOT NULL DEFAULT 0,
  total_cents integer NOT NULL DEFAULT 0,
  paid_cents integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'voided')),
  note text NOT NULL DEFAULT '',
  void_reason text NOT NULL DEFAULT '',
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT tickets_unique_per_day UNIQUE (business_date, ticket_number)
);

CREATE INDEX IF NOT EXISTS idx_tickets_business_date_status ON tickets(business_date, status);
CREATE INDEX IF NOT EXISTS idx_tickets_queue_entry_id ON tickets(queue_entry_id);
CREATE INDEX IF NOT EXISTS idx_tickets_appointment_id ON tickets(appointment_id);
CREATE INDEX IF NOT EXISTS idx_tickets_completed_service_id ON tickets(completed_service_id);
CREATE INDEX IF NOT EXISTS idx_tickets_shift_id ON tickets(shift_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status_opened_at ON tickets(status, opened_at DESC);

CREATE TABLE IF NOT EXISTS ticket_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'service'
    CHECK (kind IN ('service', 'retail', 'discount', 'gift_card_sale')),
  name text NOT NULL,
  service_id text REFERENCES salon_services(id) ON DELETE SET NULL,
  staff1_id text REFERENCES manicurists(id) ON DELETE SET NULL,
  staff1_name text NOT NULL DEFAULT '',
  staff1_color text NOT NULL DEFAULT '#9ca3af',
  staff2_id text REFERENCES manicurists(id) ON DELETE SET NULL,
  staff2_name text NOT NULL DEFAULT '',
  staff2_color text NOT NULL DEFAULT '#9ca3af',
  unit_price_cents integer NOT NULL DEFAULT 0,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  discount_cents integer NOT NULL DEFAULT 0,
  ext_price_cents integer NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_items_ticket_id ON ticket_items(ticket_id);

CREATE TABLE IF NOT EXISTS shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_date date NOT NULL,
  drawer_number integer NOT NULL DEFAULT 1,
  opened_at timestamptz NOT NULL DEFAULT now(),
  opened_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  opening_cash_cents integer NOT NULL DEFAULT 0,
  closed_at timestamptz,
  closed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  expected_cash_cents integer,
  declared_cash_cents integer,
  variance_cents integer,
  variance_note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed'))
);

CREATE INDEX IF NOT EXISTS idx_shifts_business_date_status ON shifts(business_date, status);
CREATE INDEX IF NOT EXISTS idx_shifts_status_opened_at ON shifts(status, opened_at DESC);

ALTER TABLE tickets
  ADD CONSTRAINT tickets_shift_id_fkey
  FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  shift_id uuid REFERENCES shifts(id) ON DELETE SET NULL,
  method text NOT NULL CHECK (method IN ('cash', 'visa_mc', 'gift')),
  amount_cents integer NOT NULL,
  tendered_cents integer,
  change_cents integer,
  gift_card_code text NOT NULL DEFAULT '',
  processor text NOT NULL DEFAULT 'manual' CHECK (processor IN ('manual', 'square', 'stripe')),
  processor_payment_id text NOT NULL DEFAULT '',
  card_brand text NOT NULL DEFAULT '',
  card_last4 text NOT NULL DEFAULT '',
  refund_of uuid REFERENCES payments(id) ON DELETE SET NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_ticket_id ON payments(ticket_id);
CREATE INDEX IF NOT EXISTS idx_payments_shift_id ON payments(shift_id);
CREATE INDEX IF NOT EXISTS idx_payments_method_captured_at ON payments(method, captured_at DESC);

CREATE TABLE IF NOT EXISTS shift_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('pay_in', 'pay_out')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_shift_movements_shift_id ON shift_movements(shift_id);

ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_movements ENABLE ROW LEVEL SECURITY;

DO $outer$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['tickets', 'ticket_items', 'payments', 'shifts', 'shift_movements']
  LOOP
    EXECUTE format(
      'DO $inner$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = %L AND policyname = %L) THEN
         CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);
       END IF; END $inner$;',
      tbl, tbl || '_select', tbl || '_select', tbl
    );
    EXECUTE format(
      'DO $inner$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = %L AND policyname = %L) THEN
         CREATE POLICY %I ON %I FOR INSERT TO authenticated WITH CHECK (auth.uid() IS NOT NULL);
       END IF; END $inner$;',
      tbl, tbl || '_insert', tbl || '_insert', tbl
    );
    EXECUTE format(
      'DO $inner$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = %L AND policyname = %L) THEN
         CREATE POLICY %I ON %I FOR UPDATE TO authenticated USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
       END IF; END $inner$;',
      tbl, tbl || '_update', tbl || '_update', tbl
    );
    EXECUTE format(
      'DO $inner$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = %L AND policyname = %L) THEN
         CREATE POLICY %I ON %I FOR DELETE TO authenticated USING (auth.uid() IS NOT NULL);
       END IF; END $inner$;',
      tbl, tbl || '_delete', tbl || '_delete', tbl
    );
  END LOOP;
END $outer$;
