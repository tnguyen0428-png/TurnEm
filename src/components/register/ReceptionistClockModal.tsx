// ReceptionistClockModal — PIN-gated clock-in / clock-out for receptionists.
//
// Triggered from the Register screen's sun/moon pill. Flow:
//   1. Receptionist enters their passcode (PIN).
//   2. Their name + the current time appears, with the action (CLOCK IN or
//      CLOCK OUT) derived from whether they're currently clocked in.
//   3. They confirm. We write the clock_events row FIRST (the durable,
//      cross-device log), then dispatch the CLOCK_IN/CLOCK_OUT toggle via the
//      parent callbacks. Writing the event first means a failed DB write
//      leaves nothing changed, so the synced `clockedIn` flag and the hours
//      log can't drift apart.
//
// The parent owns the store dispatch (onClockIn/onClockOut); this component
// owns the PIN check, the confirm step, and the clock_events append.

import { useEffect, useRef, useState } from 'react';
import { X, Lock, Sun, Moon, ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  appendEvent as appendClockEvent,
  getEventsForStaff,
  sessionsFromEvents,
} from '../../lib/clockLog';
import type { ClockEvent, ClockSession } from '../../lib/clockLog';
import type { Manicurist } from '../../types';

interface Props {
  receptionists: Manicurist[];
  onClose: () => void;
  onClockIn: (id: string) => void;
  onClockOut: (id: string) => void;
}

type Stage =
  | { name: 'pin' }
  | { name: 'confirm'; receptionist: Manicurist; action: 'in' | 'out'; at: number; confirmed: boolean };

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(ms));
}

const MS_DAY = 24 * 60 * 60 * 1000;
const MS_HOUR = 60 * 60 * 1000;
// Overtime thresholds — same California-style rule the admin Receptionist
// Hours report uses, so the two never disagree: daily OT past 8h, weekly OT
// past 40h of straight time (no pyramiding).
const DAILY_OT_MS = 8 * MS_HOUR;
const WEEKLY_OT_MS = 40 * MS_HOUR;

// Local midnight of the day containing `ms` — used to bucket worked time per
// day for the daily-OT calc.
function startOfDayLocal(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Split a week's per-day worked durations into regular vs overtime.
function weekOvertime(perDayMs: number[]): { totalMs: number; regularMs: number; otMs: number } {
  let weekStraight = 0;
  let weekDailyOt = 0;
  let totalMs = 0;
  for (const dayMs of perDayMs) {
    totalMs += dayMs;
    const dailyOt = Math.max(0, dayMs - DAILY_OT_MS);
    weekDailyOt += dailyOt;
    weekStraight += dayMs - dailyOt;
  }
  const weeklyOt = Math.max(0, weekStraight - WEEKLY_OT_MS);
  const otMs = weekDailyOt + weeklyOt;
  return { totalMs, regularMs: totalMs - otMs, otMs };
}

// Local midnight of the Sunday that begins the week containing `ms`. The salon
// work week runs Sunday → Saturday; getDay() returns 0 for Sunday.
function startOfWeekSun(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d.getTime();
}

// "Jun 14 – Jun 20" for the week beginning weekStartMs.
function weekRangeLabel(weekStartMs: number): string {
  const fmt = (ms: number) =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(ms));
  return `${fmt(weekStartMs)} – ${fmt(weekStartMs + 6 * MS_DAY)}`;
}

// ms duration → "8h 05m" / "—" when unknown.
function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

// Short clock like "9:02a" / "5:31p" to keep day rows compact.
function shortClock(ms: number): string {
  const s = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    .format(new Date(ms))
    .toLowerCase()
    .replace(' ', '');
  return s.replace('am', 'a').replace('pm', 'p');
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function dayLabel(ms: number): { dow: string; date: string } {
  const d = new Date(ms);
  return { dow: WEEKDAY[d.getDay()], date: `${d.getMonth() + 1}/${d.getDate()}` };
}

export default function ReceptionistClockModal({
  receptionists,
  onClose,
  onClockIn,
  onClockOut,
}: Props) {
  const [stage, setStage] = useState<Stage>({ name: 'pin' });
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // This + previous week of the identified receptionist's own clock events,
  // loaded once their PIN matches and refreshed after a punch lands.
  const [events, setEvents] = useState<ClockEvent[] | null>(null);
  const pinRef = useRef<HTMLInputElement>(null);

  // Pull the receptionist's events back to the start of LAST week (Sunday) —
  // enough for the this-week / last-week toggle, nothing more.
  async function loadEvents(staffId: string) {
    const since = startOfWeekSun(Date.now()) - 7 * MS_DAY;
    const rows = await getEventsForStaff(staffId, since);
    setEvents(rows);
  }

  // Live-updating "now" so the confirm screen's clock ticks while the
  // receptionist reads it. The actual event is stamped at confirm-press time.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Esc cancels.
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Auto-focus the PIN box on mount.
  useEffect(() => {
    if (stage.name === 'pin') {
      const t = setTimeout(() => pinRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [stage.name]);

  function submitPin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // Identify the receptionist purely by PIN. First match wins — PINs are
    // personal credentials, unique per receptionist.
    const match = receptionists.find((r) => r.pinCode && r.pinCode === pin);
    if (!match) {
      setError('Incorrect PIN.');
      setPin('');
      setTimeout(() => pinRef.current?.focus(), 0);
      return;
    }
    setStage({
      name: 'confirm',
      receptionist: match,
      action: match.clockedIn ? 'out' : 'in',
      at: Date.now(),
      confirmed: false,
    });
    setEvents(null);
    loadEvents(match.id);
  }

  function backToPin() {
    setStage({ name: 'pin' });
    setPin('');
    setError(null);
    setEvents(null);
  }

  async function confirm() {
    if (stage.name !== 'confirm' || stage.confirmed || saving) return;
    setSaving(true);
    setError(null);
    const { receptionist, action } = stage;
    // Write the durable log row first; only flip the synced toggle if it lands.
    const ev = await appendClockEvent(receptionist.id, receptionist.name, action);
    if (!ev) {
      setError('Could not save — check the connection and try again.');
      setSaving(false);
      return;
    }
    if (action === 'in') onClockIn(receptionist.id);
    else onClockOut(receptionist.id);
    // Keep the modal up showing the now-updated week. Optimistically fold the
    // new event in, then refetch for the authoritative list.
    setEvents((prev) => (prev ? [ev, ...prev] : [ev]));
    loadEvents(receptionist.id);
    setStage({ ...stage, confirmed: true });
    setSaving(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm flex flex-col animate-modal-in">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-bebas text-2xl tracking-widest text-gray-900">TIME CLOCK</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600"
          >
            <X size={18} />
          </button>
        </div>

        {stage.name === 'pin' ? (
          /* ── Stage 1: passcode ─────────────────────────────────────────── */
          <form onSubmit={submitPin} className="px-6 py-6 flex flex-col gap-4">
            <div className="flex items-center gap-2 text-gray-500">
              <Lock size={15} />
              <span className="font-mono text-xs">Enter your passcode to clock in or out.</span>
            </div>
            <input
              ref={pinRef}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={(e) => { setPin(e.target.value); setError(null); }}
              placeholder="••••"
              className="px-4 py-3 rounded-xl border border-gray-200 font-mono text-lg tracking-[0.4em] text-center focus:outline-none focus:ring-2 focus:ring-pink-300"
            />
            {error && <p className="font-mono text-xs text-red-500 text-center">{error}</p>}
            <button
              type="submit"
              disabled={pin.length === 0}
              className="w-full py-3 rounded-xl bg-gray-900 text-white font-mono text-xs font-bold tracking-widest hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              CONTINUE
            </button>
          </form>
        ) : (
          /* ── Stage 2: name + time + week hours + confirm ───────────────── */
          <div className="px-6 py-5 flex flex-col items-center gap-3">
            <div
              className={`flex items-center gap-2 px-3 py-1 rounded-full font-mono text-[11px] font-bold tracking-widest ${
                stage.action === 'in'
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-indigo-50 text-indigo-700'
              }`}
            >
              {stage.action === 'in' ? <Sun size={13} /> : <Moon size={13} />}
              {stage.confirmed
                ? (stage.action === 'in' ? 'CLOCKED IN' : 'CLOCKED OUT')
                : (stage.action === 'in' ? 'CLOCK IN' : 'CLOCK OUT')}
            </div>

            <div className="text-center">
              <div className="flex items-center justify-center gap-2">
                <span
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: stage.receptionist.color }}
                />
                <span className="font-bebas text-3xl tracking-wide text-gray-900">
                  {stage.receptionist.name}
                </span>
              </div>
              <div className="font-mono text-2xl font-semibold text-gray-700 mt-1 tabular-nums">
                {stage.confirmed ? formatTime(stage.at) : formatTime(now)}
              </div>
            </div>

            <WeekHoursPanel
              events={events}
              staffId={stage.receptionist.id}
              pendingAction={stage.confirmed ? null : { action: stage.action, at: stage.at }}
            />

            {error && <p className="font-mono text-xs text-red-500 text-center">{error}</p>}

            {stage.confirmed ? (
              <button
                onClick={onClose}
                className="w-full py-3 rounded-xl bg-gray-900 text-white font-mono text-xs font-bold tracking-widest hover:bg-gray-800"
              >
                DONE
              </button>
            ) : (
              <div className="flex gap-2 w-full mt-0.5">
                <button
                  onClick={backToPin}
                  disabled={saving}
                  className="flex items-center justify-center gap-1.5 px-3 py-3 rounded-xl border border-gray-200 text-gray-600 font-mono text-xs font-bold hover:bg-gray-50 disabled:opacity-50"
                >
                  <ArrowLeft size={14} /> BACK
                </button>
                <button
                  onClick={confirm}
                  disabled={saving}
                  className={`flex-1 py-3 rounded-xl text-white font-mono text-xs font-bold tracking-widest disabled:opacity-60 ${
                    stage.action === 'in'
                      ? 'bg-emerald-600 hover:bg-emerald-700'
                      : 'bg-indigo-600 hover:bg-indigo-700'
                  }`}
                >
                  {saving
                    ? 'SAVING…'
                    : stage.action === 'in' ? 'CONFIRM CLOCK IN' : 'CONFIRM CLOCK OUT'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Row shape the panel renders — one per work session (or the pending punch).
interface HoursRow {
  ms: number;                 // anchor for sort/day labelling
  inStr: string;
  outStr: string;
  durStr: string;
  kind: 'done' | 'open' | 'pending';
}

// WeekHoursPanel — the receptionist's own shifts for the selected week, with a
// this-week / last-week toggle. Sunday → Saturday. Read-only; paging is capped
// at last week (offset 0 or 1).
function WeekHoursPanel({
  events,
  staffId,
  pendingAction,
}: {
  events: ClockEvent[] | null;
  staffId: string;
  pendingAction: { action: 'in' | 'out'; at: number } | null;
}) {
  const [offset, setOffset] = useState(0); // 0 = this week, 1 = last week

  const thisWeekStart = startOfWeekSun(Date.now());
  const weekStart = thisWeekStart - offset * 7 * MS_DAY;
  const weekEnd = weekStart + 7 * MS_DAY;

  const sessions: ClockSession[] = events
    ? sessionsFromEvents(events).filter((s) => s.staffId === staffId)
    : [];

  const rows: HoursRow[] = [];
  const perDayMs = new Map<number, number>(); // local day → worked ms (completed only)
  for (const s of sessions) {
    const anchor = s.startTime ?? s.endTime;
    if (anchor == null || anchor < weekStart || anchor >= weekEnd) continue;
    if (s.endTime == null) {
      rows.push({
        ms: anchor,
        inStr: s.startTime ? shortClock(s.startTime) : '?',
        outStr: '—',
        durStr: '',
        kind: 'open',
      });
    } else {
      if (s.durationMs) {
        const dk = startOfDayLocal(anchor);
        perDayMs.set(dk, (perDayMs.get(dk) ?? 0) + s.durationMs);
      }
      rows.push({
        ms: anchor,
        inStr: s.startTime ? shortClock(s.startTime) : '?',
        outStr: shortClock(s.endTime),
        durStr: formatDuration(s.durationMs),
        kind: 'done',
      });
    }
  }
  const { totalMs, otMs } = weekOvertime(Array.from(perDayMs.values()));

  // Clock-in not yet saved: show today's punch as a pending "now" row.
  if (pendingAction?.action === 'in' && offset === 0) {
    rows.push({
      ms: pendingAction.at,
      inStr: shortClock(pendingAction.at),
      outStr: '—',
      durStr: '',
      kind: 'pending',
    });
  }

  rows.sort((a, b) => a.ms - b.ms);

  return (
    <div className="w-full rounded-xl border border-gray-100 bg-gray-50/60 px-3 pt-2 pb-2.5">
      {/* Week toggle */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setOffset((o) => Math.min(1, o + 1))}
          disabled={offset >= 1}
          aria-label="Previous week"
          className="w-7 h-7 flex items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-30"
        >
          <ChevronLeft size={15} />
        </button>
        <div className="text-center">
          <div className="font-bebas text-sm tracking-[2px] text-gray-800 leading-none">YOUR HOURS</div>
          <div className="font-mono text-[10px] text-gray-500 mt-0.5">
            {offset === 0 ? 'This week' : 'Last week'} · {weekRangeLabel(weekStart)}
          </div>
        </div>
        <button
          onClick={() => setOffset((o) => Math.max(0, o - 1))}
          disabled={offset <= 0}
          aria-label="Next week"
          className="w-7 h-7 flex items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-30"
        >
          <ChevronRight size={15} />
        </button>
      </div>

      {/* Rows */}
      <div className="mt-2 flex flex-col gap-1">
        {events == null ? (
          <div className="py-4 text-center font-mono text-[11px] text-gray-400">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="py-4 text-center font-mono text-[11px] text-gray-400">No shifts this week yet.</div>
        ) : (
          rows.map((r, i) => {
            const { dow, date } = dayLabel(r.ms);
            const pending = r.kind === 'pending';
            const open = r.kind === 'open';
            return (
              <div
                key={`${r.ms}-${i}`}
                className={`flex items-center justify-between px-2.5 py-1.5 rounded-lg ${
                  pending ? 'bg-amber-50 border border-dashed border-amber-300' : 'bg-white'
                }`}
              >
                <div className="flex items-baseline gap-1.5 min-w-[64px]">
                  <span className="font-mono text-xs font-bold text-gray-900">{dow}</span>
                  <span className="font-mono text-[10px] text-gray-400">{date}</span>
                </div>
                <div className={`flex-1 text-center font-mono text-[11px] ${pending ? 'text-amber-700' : 'text-gray-600'}`}>
                  {pending || open ? `in ${r.inStr}` : `${r.inStr} → ${r.outStr}`}
                </div>
                <div className="min-w-[58px] text-right">
                  {pending ? (
                    <span className="font-mono text-[10px] font-bold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">NOW</span>
                  ) : open ? (
                    <span className="font-mono text-[10px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full">ON DUTY</span>
                  ) : (
                    <span className="font-mono text-xs font-semibold text-gray-900">{r.durStr}</span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Week total + overtime */}
      <div className="mt-2 pt-2 border-t border-dashed border-gray-200 flex items-center justify-between">
        <span className="font-mono text-[11px] font-bold tracking-wide text-gray-600">WEEK TOTAL</span>
        <div className="flex items-center gap-2">
          {otMs > 0 && (
            <span className="font-mono text-[10px] font-bold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">
              {formatDuration(otMs)} OT
            </span>
          )}
          <span className="font-mono text-sm font-bold text-gray-900">{formatDuration(totalMs)}</span>
        </div>
      </div>
    </div>
  );
}
