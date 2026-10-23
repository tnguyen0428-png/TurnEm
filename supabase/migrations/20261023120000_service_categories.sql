-- Service categories become first-class rows so the Services screen can
-- rename, recolor and reorder them (and add new ones) instead of reading the
-- hardcoded SERVICE_CATEGORIES list. Combo and Wax Services are locked: the
-- turn/priority rules key off those names, so they can be recolored and
-- reordered but never renamed or deleted (enforced in the reducer).
CREATE TABLE IF NOT EXISTS service_categories (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  color text NOT NULL DEFAULT 'gray',
  sort_order int NOT NULL DEFAULT 0,
  is_locked boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE service_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY service_categories_select ON service_categories
  FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);
CREATE POLICY service_categories_insert ON service_categories
  FOR INSERT TO authenticated WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY service_categories_update ON service_categories
  FOR UPDATE TO authenticated USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY service_categories_delete ON service_categories
  FOR DELETE TO authenticated USING (auth.uid() IS NOT NULL);

ALTER PUBLICATION supabase_realtime ADD TABLE service_categories;

-- Seed mirrors DEFAULT_SERVICE_CATEGORIES in src/constants/services.ts.
INSERT INTO service_categories (id, name, color, sort_order, is_locked) VALUES
  ('acrylic-fill',       'Acrylic Fill',         'rose',    0, false),
  ('acrylic-full-set',   'Acrylic Full Set',     'rose',    1, false),
  ('healthy-nails',      'Healthy Nails',        'emerald', 2, false),
  ('manicures',          'Manicures',            'sky',     3, false),
  ('pedicures',          'Pedicures',            'sky',     4, false),
  ('combo',              'Combo',                'amber',   5, true),
  ('kids-services',      'Kids Services',        'pink',    6, false),
  ('a-la-carte-add-ons', 'A La Carte & Add-Ons', 'teal',    7, false),
  ('wax-services',       'Wax Services',         'orange',  8, true),
  ('special-request',    'Special Request',      'purple',  9, false)
ON CONFLICT (id) DO NOTHING;
