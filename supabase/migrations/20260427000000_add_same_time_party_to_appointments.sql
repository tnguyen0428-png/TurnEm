-- Adds the "same time" visual flag and "party group" link id to appointments.
-- Both fields are optional/defaultable so existing rows remain valid.
-- same_time: boolean — UI flag indicating client wants the same time as another booking.
-- party_id:  text     — id linking appointments belonging to the same party group.
--                       Auto-assigned when "Party group" is checked in the booking modal.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS same_time boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS party_id text;

CREATE INDEX IF NOT EXISTS appointments_party_id_idx ON appointments (party_id) WHERE party_id IS NOT NULL;
