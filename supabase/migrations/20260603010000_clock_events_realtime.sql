-- Add clock_events to the realtime publication so the Receptionist Hours
-- report updates live (no 60s poll wait) when any device clocks in/out or a
-- manager edits an entry. Mirrors the existing live-ops tables.
ALTER PUBLICATION supabase_realtime ADD TABLE clock_events;
