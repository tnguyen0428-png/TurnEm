import { useMemo, useState, useEffect } from 'react';
import { useApp } from '../../state/AppContext';

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
// front of the receptionist who can verify it against the slot and fix it.
//
// Deliberately computed from live state rather than polled from the DB - the
// queue and the bookings are both already in memory, so it reacts immediately
// instead of on a timer.
//
// Reports only. It never rewrites turnValue: turn values feed queue ORDER, and
// silently reordering the rotation is worse than the bug.

const SNOOZE_MS = 30 * 60 * 1000; // re-raise after 30 min if still unfixed
const SNOOZE_KEY = 'turnem.lostRequestSnooze';

type Snoozed = Record<string, number>;

function readSnoozed(): Snoozed {
  try {
    const raw = localStorage.getItem(SNOOZE_KEY);
    return raw ? (JSON.parse(raw) as Snoozed) : {};
  } catch {
    return {};
  }
}

function writeSnoozed(s: Snoozed) {
  try {
    localStorage.setItem(SNOOZE_KEY, JSON.stringify(s));
  } catch {
    /* private mode / quota - the alert simply keeps showing, which is the safe side */
  }
}

export default function LostRequestAlert() {
  const { state } = useApp();
  const [snoozed, setSnoozed] = useState<Snoozed>(() => readSnoozed());
  // Re-evaluate on a slow tick so a snooze can expire without needing a state
  // change to wake the memo.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const offenders = useMemo(() => {
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

      const until = snoozed[q.id];
      if (typeof until === 'number' && until > now) return [];

      const techs = Array.from(
        new Set(wanted.flatMap((r) => (r.manicuristIds ?? []).map((id) => nameById.get(id) ?? id))),
      );
      return [{
        id: q.id,
        clientName: q.clientName,
        services: Array.from(new Set(wanted.map((r) => r.service))),
        techs,
        turnValue: Number(q.turnValue) || 0,
      }];
    });
    // `tick` is intentionally a dependency and intentionally unused in the body:
    // it is what re-runs this memo once a minute so an expired snooze re-raises
    // the alert without needing a queue change to wake it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.queue, state.appointments, state.manicurists, snoozed, tick]);

  if (offenders.length === 0) return null;

  const dismiss = () => {
    const now = Date.now();
    const next = { ...snoozed };
    for (const o of offenders) next[o.id] = now + SNOOZE_MS;
    // Drop expired keys so this cannot grow forever.
    for (const [k, v] of Object.entries(next)) if (v <= now) delete next[k];
    setSnoozed(next);
    writeSnoozed(next);
  };

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Requested tech missing from the queue"
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
            rotation will be wrong until this is fixed.
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
                  counted as {o.turnValue.toFixed(1)} turn{o.turnValue === 1 ? '' : 's'} — a request should be 0.5
                </p>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={dismiss}
            style={{
              width: '100%', padding: '11px 14px', borderRadius: 10, border: 'none',
              background: '#111827', color: 'white', fontWeight: 700, fontSize: 14, cursor: 'pointer',
            }}
          >
            Got it — remind me in 30 min if still wrong
          </button>
        </div>
      </div>
    </div>
  );
}
