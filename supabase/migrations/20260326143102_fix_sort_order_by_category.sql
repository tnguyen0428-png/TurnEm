/*
  # Fix sort_order to respect category grouping

  Reassigns sort_order values so services are ordered by category group first,
  then by their relative order within the category.

  Category order:
  1. Acrylics (1-99)
  2. Healthy Nails (100-199)
  3. Manicure & Pedicure (200-299)
  4. Combo (300-399)
  5. Kids Services (400-499)
  6. A La Carte & Add-Ons (500-599)
  7. Wax Services (600-699)
*/

DO $$
DECLARE
  rec RECORD;
  cat_offset INT;
  row_num INT;
BEGIN
  FOR rec IN (
    SELECT id, category, sort_order,
      ROW_NUMBER() OVER (PARTITION BY category ORDER BY sort_order, name) AS rn
    FROM salon_services
  )
  LOOP
    cat_offset := CASE rec.category
      WHEN 'Acrylics' THEN 0
      WHEN 'Healthy Nails' THEN 100
      WHEN 'Manicure & Pedicure' THEN 200
      WHEN 'Combo' THEN 300
      WHEN 'Kids Services' THEN 400
      WHEN 'A La Carte & Add-Ons' THEN 500
      WHEN 'Wax Services' THEN 600
      ELSE 700
    END;
    UPDATE salon_services SET sort_order = cat_offset + rec.rn WHERE id = rec.id;
  END LOOP;
END $$;
