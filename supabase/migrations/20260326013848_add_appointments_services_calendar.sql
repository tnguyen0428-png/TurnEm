/*
  # Add Appointments, Salon Services, Turn Criteria, and Calendar tables

  1. New Tables
    - `appointments`
      - `id` (uuid, primary key)
      - `client_name` (text)
      - `client_phone` (text, default '')
      - `service` (text)
      - `manicurist_id` (uuid, nullable)
      - `date` (text) - formatted as YYYY-MM-DD
      - `time` (text) - formatted as HH:MM
      - `notes` (text, default '')
      - `status` (text, default 'scheduled')
      - `created_at` (timestamptz)
    - `salon_services`
      - `id` (uuid, primary key)
      - `name` (text)
      - `turn_value` (numeric)
      - `duration` (integer, minutes)
      - `price` (numeric)
      - `is_active` (boolean, default true)
      - `category` (text, default '')
    - `turn_criteria`
      - `id` (uuid, primary key)
      - `name` (text)
      - `description` (text)
      - `priority` (integer)
      - `enabled` (boolean, default true)
      - `type` (text)
      - `value` (numeric)
    - `calendar_days`
      - `date` (text, primary key) - YYYY-MM-DD format
      - `status` (text, default 'open')
      - `note` (text, default '')

  2. Security
    - Enable RLS on all new tables
    - Add policies for authenticated users
*/

CREATE TABLE IF NOT EXISTS appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_name text NOT NULL DEFAULT '',
  client_phone text NOT NULL DEFAULT '',
  service text NOT NULL,
  manicurist_id uuid,
  date text NOT NULL,
  time text NOT NULL,
  notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'scheduled',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view appointments"
  ON appointments FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert appointments"
  ON appointments FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update appointments"
  ON appointments FOR UPDATE
  TO authenticated
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can delete appointments"
  ON appointments FOR DELETE
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE TABLE IF NOT EXISTS salon_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  turn_value numeric NOT NULL DEFAULT 0.5,
  duration integer NOT NULL DEFAULT 30,
  price numeric NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  category text NOT NULL DEFAULT ''
);

ALTER TABLE salon_services ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view salon services"
  ON salon_services FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert salon services"
  ON salon_services FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update salon services"
  ON salon_services FOR UPDATE
  TO authenticated
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can delete salon services"
  ON salon_services FOR DELETE
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE TABLE IF NOT EXISTS turn_criteria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  priority integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  type text NOT NULL DEFAULT 'sort',
  value numeric NOT NULL DEFAULT 0
);

ALTER TABLE turn_criteria ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view turn criteria"
  ON turn_criteria FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert turn criteria"
  ON turn_criteria FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update turn criteria"
  ON turn_criteria FOR UPDATE
  TO authenticated
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can delete turn criteria"
  ON turn_criteria FOR DELETE
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE TABLE IF NOT EXISTS calendar_days (
  date text PRIMARY KEY,
  status text NOT NULL DEFAULT 'open',
  note text NOT NULL DEFAULT ''
);

ALTER TABLE calendar_days ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view calendar days"
  ON calendar_days FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can insert calendar days"
  ON calendar_days FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can update calendar days"
  ON calendar_days FOR UPDATE
  TO authenticated
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Authenticated users can delete calendar days"
  ON calendar_days FOR DELETE
  TO authenticated
  USING (auth.uid() IS NOT NULL);
