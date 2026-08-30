import { useMemo, useState, useEffect } from 'react';
import { useApp } from '../../state/AppContext';
import { SERVICE_TURN_VALUES } from '../../constants/services';
import type { ServiceType } from '../../types';

// ─── Lost-request alert ──────────────────────────────────────────────────────
//
// A booking that says "request TOMMY" must arrive in the queue flagged as a
// request, because a request earns a HALF turn. Recorded as a non-request the
// tech takes a FULL turn, drops down the rotation, and every customer after
// them is misrouted for the REST OF THE DAY (Nancy x TOMMY, 2026-08-26 - caught
// by hand; unspotted, Tommy's turn would have been wrong all day).
//
// The nightly check is a backstop only: by 23:30 the damage is done and nobody
// remembers the visit. This fires while the client is still in the queue, in
// front of the receptionist who can verify it against the slot and act.
//
// Computed from live state rather than polled - the queue and the bookings are
// both already in memory, so it reacts immediately instead of on a timer.

const SNOOZE_MS = 15 * 60 * 1000; // "Dismiss for now" - re-raise in 15 min
const ACCEPT_MS = 12 * 60 * 60 * 1000; // "Leave it as is" - gone for this visit
const SNOOZE_KEY = 'turnem.lostRequestSnooze';
const ACCEPT_KEY = 'turnem.lostRequestAccepted';

type Stamps = Record<string, number>;

function readMap(key: string): Stamps {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Stamps) : {};
  } catch {
    return {};
  }
}

function writeMap(key: string, s: Stamps) {
  try {
    localStorage.setItem(key, JSON.stringify(s));
  } catch {
    /* private mode / quota - the alert simply keeps showing, which is the safe side */
  }
}

/** One other entry on the same booking, shown so the flagged row can be judged
 *  in context rather than in isolation. */
interface Sibling {
  id: string;
  techName: string;
  services: string[];
  turnValue: number;
  requested: boolean;
}

interface Offender {
  id: string;
  clientName: string;
  services: string[];
  techIds: string[];
  techs: string[];
  turnValue: number;
  correctedTurns: number;
  /** Every request the BOOKING carries, as "Service → TECH". A party with four
   *  same-named services and one request is the case that made this alert
   *  unjudgeable: the card said "should be 0.5" with no way to see that the
   *  single request was already accounted for elsewhere. */
  bookingRequests: string[];
  /** The other entries on this booking, so the whole party is visible. */
  siblings: Sibling[];
}

export default function LostRequestAlert() {
  const { state, dispatch } = useApp();
  const [snoozed, setSnoozed] = useState<Stamps>(() => readMap(SNOOZE_KEY));
  const [accepted, setAccepted] = useState<Stamps>(() => readMap(ACCEPT_KEY));
  // Slow tick so an expired snooze re-raises without needing a queue change.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const offenders = useMemo<Offender[]>(() => {
    const now = Date.now();
    const nameById = new Map(state.manicurists.map((m) => [m.id, m.name]));

    // Walk per BOOKING, not per queue entry, so each request slot can be
    // claimed once and once only.
    //
    // Matching per entry on service NAME alone flagged every sibling of a
    // party: Dina 2026-08-29 booked four Gel Pedicures, one a request for
    // HANA, and the other three each matched that request by name and were
    // reported as "booked as a request for HANA — counted as 1.5, should be
    // 0.5". All four were already correct. A false alarm here is worse than
    // silence: it teaches the front desk to click past the popup that exists
    // to catch real turn errors.
    //
    // Two rules together make a request THIS entry's:
    //   - the tech actually doing it is a tech the customer asked for. Asked
    //     for HANA and got PANDA? PANDA earns a full turn, nothing to correct.
    //   - the request slot hasn't already been claimed by another entry. One
    //     request for HANA explains ONE pedicure, not both of HANA's (Janie
    //     Vera 2026-07-11 is the shape: same tech, two slots of one service,
    //     one of them a request).
    const byAppt = new Map<string, typeof state.queue>();
    for (const q of state.queue) {
      const apptId = q.originalAppointment?.id;
      if (!apptId) continue; // never came from a booking
      const list = byAppt.get(apptId) ?? [];
      list.push(q);
      byAppt.set(apptId, list);
    }

    const out: Offender[] = [];
    for (const [apptId, entries] of byAppt) {
      // Compare against the CURRENT booking, not the check-in snapshot: the
      // booking is the authority and it is what the receptionist can see.
      const appt = state.appointments.find((a) => a.id === apptId);
      if (!appt) continue;
      const reqs = (appt.serviceRequests ?? []).filter(
        (r) => r.clientRequest === true && (r.manicuristIds?.length ?? 0) > 0,
      );
      if (reqs.length === 0) continue;

      // Entries ALREADY flagged correctly claim their slot first, so a
      // correctly-recorded request can never be left over to explain a
      // sibling that legitimately earns a full turn.
      const ordered = [...entries].sort(
        (a, b) => Number(b.isRequested === true) - Number(a.isRequested === true),
      );

      const claimed = new Set<number>();
      for (const q of ordered) {
        const entryTech = q.assignedManicuristId ?? q.requestedManicuristId ?? null;
        if (!entryTech) continue;
        const idx = reqs.findIndex(
          (r, i) =>
            !claimed.has(i) &&
            (q.services ?? []).includes(r.service) &&
            (r.manicuristIds ?? []).includes(entryTech),
        );
        if (idx < 0) continue;
        claimed.add(idx);
        if (q.isRequested === true) continue; // already correct — slot consumed, nothing to report
        if ((accepted[q.id] ?? 0) > now) continue;
        if ((snoozed[q.id] ?? 0) > now) continue;

        const wanted = [reqs[idx]];
        const techIds = Array.from(new Set(wanted.flatMap((r) => r.manicuristIds ?? [])));

        // Same formula check-in uses (AppointmentBookView.addApptToQueue): a
        // requested service is worth half a turn, except Combos which stay at 1.
        const correctedTurns = (q.services ?? []).reduce((sum, svc) => {
          const s = state.salonServices.find((ss) => ss.name === svc);
          const base = s?.turnValue ?? SERVICE_TURN_VALUES[svc as ServiceType] ?? 1;
          const isReq = wanted.some((r) => r.service === svc);
          return sum + (isReq && base > 0 ? (s?.category === 'Combo' ? 1 : 0.5) : base);
        }, 0);

        const techNameOf = (s: typeof q) => {
          const id = s.assignedManicuristId ?? s.requestedManicuristId ?? null;
          return id ? (nameById.get(id) ?? id) : 'unassigned';
        };

        out.push({
          id: q.id,
          clientName: q.clientName,
          services: Array.from(new Set(wanted.map((r) => String(r.service)))),
          techIds,
          techs: techIds.map((id) => nameById.get(id) ?? id),
          turnValue: Number(q.turnValue) || 0,
          correctedTurns,
          bookingRequests: reqs.map(
            (r) =>
              `${r.service} → ${(r.manicuristIds ?? [])
                .map((id) => nameById.get(id) ?? id)
                .join(' / ')}`,
          ),
          siblings: entries
            .filter((s) => s.id !== q.id)
            .map((s) => ({
              id: s.id,
              techName: techNameOf(s),
              services: s.services ?? [],
              turnValue: Number(s.turnValue) || 0,
              requested: s.isRequested === true,
            })),
        });
      }
    }
    return out;
    // `tick` is intentionally a dependency and intentionally unused in the body:
    // it is what re-runs this memo once a minute so an expired snooze re-raises
    // the alert without needing a queue change to wake it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.queue, state.appointments, state.manicurists, state.salonServices, snoozed, accepted, tick]);

  if (offenders.length === 0) return null;

  // ── Correct Turn ───────────────────────────────────────────────────────────
  // Flags the entry as a request and rewrites its turnValue. UPDATE_CLIENT's
  // turn maintenance applies the delta to the tech's totalTurns straight away,
  // so the rotation is right from this moment on.
  //
  // Deliberately passes ONLY these three keys. UPDATE_CLIENT mirrors
  // services / serviceRequests / assignedManicuristId back onto the linked
  // booking when they are present in `updates`, and mirroring one queue entry's
  // slice can wipe a sibling's services off the block (Jennifer Logan x SAM,
  // 2026-08-15). Omitting them leaves the booking untouched.
  //
  // isRequested + requestedManicuristId is exactly what COMPLETE_SERVICE reads
  // for `wholeEntryRequested`, so the R badge lands on the history row too.
  const correctTurn = () => {
    for (const o of offenders) {
      dispatch({
        type: 'UPDATE_CLIENT',
        id: o.id,
        updates: {
          isRequested: true,
          requestedManicuristId: o.techIds[0] ?? null,
          turnValue: o.correctedTurns,
        },
      });
    }
  };

  const remember = (map: Stamps, setMap: (m: Stamps) => void, key: string, ms: number) => {
    const now = Date.now();
    const next = { ...map };
    for (const o of offenders) next[o.id] = now + ms;
    for (const [k, v] of Object.entries(next)) if (v <= now) delete next[k];
    setMap(next);
    writeMap(key, next);
  };

  // "Leave it as is" - the receptionist checked and the current count is right.
  const leaveAsIs = () => remember(accepted, setAccepted, ACCEPT_KEY, ACCEPT_MS);
  // "Dismiss for now" - still investigating; come back in 15 minutes.
  const dismissForNow = () => remember(snoozed, setSnoozed, SNOOZE_KEY, SNOOZE_MS);

  const btn = {
    width: '100%', padding: '11px 14px', borderRadius: 10,
    fontWeight: 700, fontSize: 14, cursor: 'pointer', border: 'none',
  } as const;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Requested tech not counted in the queue"
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(15,23,42,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div style={{
        background: 'white', borderRadius: 16, maxWidth: 520, width: '100%',
        boxShadow: '0 20px 50px rgba(0,0,0,0.3)', overflow: 'hidden',
      }}>
        <div style={{ background: '#b91c1c', color: 'white', padding: '14px 18px' }}>
          <p style={{ margin: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em' }}>
            REQUEST NOT COUNTED — CHECK THE SLOT
          </p>
        </div>

        <div style={{ padding: '16px 18px' }}>
          <p style={{ margin: '0 0 12px', fontSize: 14, color: '#374151', lineHeight: 1.5 }}>
            {offenders.length === 1 ? 'This booking is' : 'These bookings are'} marked as a request,
            but {offenders.length === 1 ? 'it is' : 'they are'} in the queue as a full turn. The
            rotation will be wrong until this is settled.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            {offenders.map((o) => (
              <div key={o.id} style={{
                border: '1px solid #fecaca', background: '#fef2f2',
                borderRadius: 10, padding: '10px 12px',
              }}>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#7f1d1d' }}>
                  {o.clientName}
                </p>
                <p style={{ margin: '2px 0 0', fontSize: 13, color: '#991b1b' }}>
                  booked as a request for <strong>{o.techs.join(' / ')}</strong> — {o.services.join(', ')}
                </p>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: '#b91c1c', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>
                  counted as {o.turnValue.toFixed(1)} → should be {o.correctedTurns.toFixed(1)}
                </p>

                {/* ── Context, so this can be JUDGED and not just accepted ──
                    A flagged row on its own is unjudgeable: Dina 2026-08-29
                    was a party of four Gel Pedicures with ONE request, and
                    the card said "should be 0.5" with no way to see that the
                    request was already accounted for on another tech. Show
                    what the booking actually asked for and where every other
                    slot on it stands, so "Leave it as is" is a decision
                    rather than a guess. */}
                <div style={{
                  marginTop: 8, paddingTop: 8, borderTop: '1px dashed #fca5a5',
                  fontSize: 12, color: '#7f1d1d',
                }}>
                  <p style={{ margin: 0 }}>
                    <span style={{ color: '#9ca3af' }}>Booking asks for:</span>{' '}
                    {o.bookingRequests.length > 0 ? o.bookingRequests.join(' · ') : 'nothing'}
                  </p>

                  {o.siblings.length > 0 ? (
                    <>
                      <p style={{ margin: '6px 0 3px', color: '#9ca3af' }}>
                        Rest of this booking ({o.siblings.length}):
                      </p>
                      <ul style={{ margin: 0, paddingLeft: 16, listStyle: 'disc' }}>
                        {o.siblings.map((s) => (
                          <li key={s.id} style={{ margin: '1px 0', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>
                            {s.techName} — {s.services.join(', ') || 'no service'} — {s.turnValue.toFixed(1)}
                            {s.requested ? ' (request)' : ''}
                          </li>
                        ))}
                      </ul>
                      <p style={{ margin: '6px 0 0', color: '#9ca3af', fontStyle: 'italic' }}>
                        If a slot above already carries the request, this one
                        earns its full turn — choose “Leave it as is”.
                      </p>
                    </>
                  ) : (
                    <p style={{ margin: '6px 0 0', color: '#9ca3af' }}>
                      Only slot on this booking.
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* ── The two real answers carry EQUAL visual weight ───────────────
              Not a style preference — it is the whole point of the dialog.
              A single dark primary button gets clicked on sight: the eye goes
              to the highlight and the receptionist never reads the card. That
              is how Dina 2026-08-29 was "corrected" on a false alarm. Two
              matched pastels (green = change it, yellow = leave it) give the
              eye nothing to default to, so the only way through is to read the
              context above and choose. Keep them the same size, weight and
              saturation; do not promote either one to a solid fill.

              "Correct Turn" leads because, now that the party false-positive
              is fixed (7be0ccb / 58464a8), a firing should mean a real error.
              But it is worded "Please correct the turn": read fast, "Correct
              Turn" parses as "the turn is correct" — the exact opposite of
              what the button does. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button type="button" onClick={correctTurn}
              style={{ ...btn, background: '#d1fae5', color: '#065f46', border: '1px solid #6ee7b7' }}>
              Please correct the turn
            </button>
            <button type="button" onClick={leaveAsIs}
              style={{ ...btn, background: '#fef3c7', color: '#92400e', border: '1px solid #fcd34d' }}>
              Leave it as is — the count is right
            </button>
            <button type="button" onClick={dismissForNow}
              style={{ ...btn, background: 'white', color: '#6b7280', border: '1px solid #e5e7eb', fontWeight: 600 }}>
              Dismiss for now — remind me in 15 min
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
