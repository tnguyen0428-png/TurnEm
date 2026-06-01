-- Phantom fix, PHASE 2 — remove the legacy composite-key dedupe.
--
-- Applied live to the TurnEM Salon project on 2026-06-01, AFTER the line_uid
-- client (Phase 1 + client threading) was deployed and verified writing
-- line_uid (ticket #79).
--
-- Why: these two mechanisms refused ANY second line with the same
-- (name, staff, price). That silently deleted a LEGITIMATE repeat service
-- (same service, same technician, twice) and undercharged the client. Now that
-- line_uid + ON CONFLICT DO NOTHING prevents phantom duplicates structurally,
-- these blanket blockers can come off so real repeat services stick.
--
-- The matching client-side composite-key filter in updateOpenTicket
-- (src/lib/tickets.ts) was removed in the same change.
--
-- KEPT (still correct, do not drop):
--   * ticket_items_reject_on_closed_unconditional  (Guard A, race-proof via FOR SHARE)
--   * ticket_items_guard_voided                    (protects voided tickets)
--   * uniq_ticket_items_line_uid                    (the new idempotency index)
--   * uniq_ticket_items_per_entry                  (per-(ticket,qid) guard; nulls exempt,
--                                                    modal dups are #N-disambiguated)

DROP TRIGGER IF EXISTS ticket_items_reject_duplicate_composite_key ON public.ticket_items;
DROP FUNCTION IF EXISTS public.reject_ticket_items_duplicate_composite_key();
DROP INDEX IF EXISTS public.uniq_ticket_items_visit_service;
