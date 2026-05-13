-- Add customers to the realtime publication so Blueprint → Customers
-- auto-updates when an appointment / queue intake on another tab or device
-- creates a profile.
--
-- Idempotent: if the table is already a publication member, the inner
-- ALTER raises duplicate_object which we swallow.
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.customers;
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;
END $$;
