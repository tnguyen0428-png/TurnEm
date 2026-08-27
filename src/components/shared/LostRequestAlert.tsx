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

interface Offender {
  id: string;
  clientName: string;
  services: string[];
  techIds: string[];
  techs: string[];
  turnValue: number;
  correctedTurns: number;
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

    return state.queue.flatMap((q) => {
      // Already flagged correctly, or never came from a booking.
      if (q.isRequested === true) return [];
      const apptId = q.originalAppointment?.id;
      if (!apptId) return [];

      // Compare against the CURRENT booking, not the check-in snapshot: the
      // booking is the authority and it is what the receptionist can see.
      const appt = state.appointments.find((a) => a.id === apptId);
      if (!appt) return [];

      const wanted = (appt.serviceRequests ?? []).filter(
        (r) =>
          r.clientRequest === true &&
          (r.manicuristIds?.length ?? 0) > 0 &&
          (q.services ?? []).includes(r.service),
      );
      if (wanted.length === 0) return [];

      if ((accepted[q.id] ?? 0) > now) return [];
      if ((snoozed[q.id] ?? 0) > now) return [];

      const techIds = Array.from(new Set(wanted.flatMap((r) => r.manicuristIds ?? [])));

      // Same formula check-in uses (AppointmentBookView.addApptToQueue): a
      // requested service is worth half a turn, except Combos which stay at 1.
      const correctedTurns = (q.services ?? []).reduce((sum, svc) => {
        const s = state.salonServices.find((ss) => ss.name === svc);
        const base = s?.turnValue ?? SERVICE_TURN_VALUES[svc as ServiceType] ?? 1;
        const isReq = wanted.some((r) => r.service === svc);
        return sum + (isReq && base > 0 ? (s?.category === 'Combo' ? 1 : 0.5) : base);
      }, 0);

      return [{
        id: q.id,
        clientName: q.clientName,
        services: Array.from(new Set(wanted.map((r) => String(r.service)))),
        techIds,
        techs: techIds.map((id) => nameById.get(id) ?? id),
        turnValue: Number(q.turnValue) || 0,
        correctedTurns,
      }];
    });
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
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button type="button" onClick={correctTurn}
              style={{ ...btn, background: '#059669', color: 'white' }}>
              Correct Turn
            </button>
            <button type="button" onClick={leaveAsIs}
              style={{ ...btn, background: 'white', color: '#374151', border: '1px solid #d1d5db' }}>
              Leave it as is
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
