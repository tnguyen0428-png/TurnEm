/*
  # Nail Salon Turn Management Schema

  1. New Tables
    - `manicurists`
      - `id` (uuid, primary key)
      - `name` (text, not null)
      - `color` (text, not null) - hex color code
      - `skills` (text[], not null) - array of service names
      - `clocked_in` (boolean, default false)
      - `clock_in_time` (timestamptz, nullable)
      - `total_turns` (numeric, default 0)
      - `current_client_id` (uuid, nullable)
      - `status` (text, default 'available') - available | busy | break
      - `created_at` (timestamptz, default now())

    - `queue_entries`
      - `id` (uuid, primary key)
      - `client_name` (text, not null)
      - `service` (text, not null)
      - `turn_value` (numeric, not null)
      - `requested_manicurist_id` (uuid, nullable, references manicurists)
      - `is_requested` (boolean, default false)
      - `assigned_manicurist_id` (uuid, nullable, references manicurists)
      - `status` (text, default 'waiting') - waiting | inProgress | complete
      - `arrived_at` (timestamptz, default now())
      - `started_at` (timestamptz, nullable)
      - `completed_at` (timestamptz, nullable)

    - `completed_services`
      - `id` (uuid, primary key)
      - `client_name` (text, not null)
      - `service` (text, not null)
      - `turn_value` (numeric, not null)
      - `manicurist_id` (uuid, references manicurists)
      - `manicurist_name` (text, not null)
      - `manicurist_color` (text, not null)
      - `started_at` (timestamptz, not null)
      - `completed_at` (timestamptz, default now())
      - `created_at` (timestamptz, default now())

  2. Security
    - Enable RLS on all tables
    - Add policies for anon access (this is a single-device front-desk app)
*/

CREATE TABLE IF NOT EXISTS manicurists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  color text NOT NULL DEFAULT '#10b981',
  skills text[] NOT NULL DEFAULT '{}',
  clocked_in boolean NOT NULL DEFAULT false,
  clock_in_time timestamptz,
  total_turns numeric NOT NULL DEFAULT 0,
  current_client_id uuid,
  status text NOT NULL DEFAULT 'available',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE manicurists ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon select manicurists"
  ON manicurists FOR SELECT
  TO anon
  USING (auth.jwt() ->> 'role' = 'anon');

CREATE POLICY "Allow anon insert manicurists"
  ON manicurists FOR INSERT
  TO anon
  WITH CHECK (auth.jwt() ->> 'role' = 'anon');

CREATE POLICY "Allow anon update manicurists"
  ON manicurists FOR UPDATE
  TO anon
  USING (auth.jwt() ->> 'role' = 'anon')
  WITH CHECK (auth.jwt() ->> 'role' = 'anon');

CREATE POLICY "Allow anon delete manicurists"
  ON manicurists FOR DELETE
  TO anon
  USING (auth.jwt() ->> 'role' = 'anon');

CREATE TABLE IF NOT EXISTS queue_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_name text NOT NULL DEFAULT 'Walk-in',
  service text NOT NULL,
  turn_value numeric NOT NULL,
  requested_manicurist_id uuid REFERENCES manicurists(id) ON DELETE SET NULL,
  is_requested boolean NOT NULL DEFAULT false,
  assigned_manicurist_id uuid REFERENCES manicurists(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'waiting',
  arrived_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

ALTER TABLE queue_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon select queue_entries"
  ON queue_entries FOR SELECT
  TO anon
  USING (auth.jwt() ->> 'role' = 'anon');

CREATE POLICY "Allow anon insert queue_entries"
  ON queue_entries FOR INSERT
  TO anon
  WITH CHECK (auth.jwt() ->> 'role' = 'anon');

CREATE POLICY "Allow anon update queue_entries"
  ON queue_entries FOR UPDATE
  TO anon
  USING (auth.jwt() ->> 'role' = 'anon')
  WITH CHECK (auth.jwt() ->> 'role' = 'anon');

CREATE POLICY "Allow anon delete queue_entries"
  ON queue_entries FOR DELETE
  TO anon
  USING (auth.jwt() ->> 'role' = 'anon');

CREATE TABLE IF NOT EXISTS completed_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_name text NOT NULL,
  service text NOT NULL,
  turn_value numeric NOT NULL,
  manicurist_id uuid REFERENCES manicurists(id) ON DELETE SET NULL,
  manicurist_name text NOT NULL,
  manicurist_color text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE completed_services ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon select completed_services"
  ON completed_services FOR SELECT
  TO anon
  USING (auth.jwt() ->> 'role' = 'anon');

CREATE POLICY "Allow anon insert completed_services"
  ON completed_services FOR INSERT
  TO anon
  WITH CHECK (auth.jwt() ->> 'role' = 'anon');

CREATE POLICY "Allow anon update completed_services"
  ON completed_services FOR UPDATE
  TO anon
  USING (auth.jwt() ->> 'role' = 'anon')
  WITH CHECK (auth.jwt() ->> 'role' = 'anon');

CREATE POLICY "Allow anon delete completed_services"
  ON completed_services FOR DELETE
  TO anon
  USING (auth.jwt() ->> 'role' = 'anon');
