// ReceptionistHoursReport — Blueprint → Reports → Receptionist Hours.
//
// Shows every clock-in / clock-out event for staff marked as receptionists.
// Filters: by receptionist (or All) and by view range (today / this week /
// this month / all / custom date range).
//
// Each row in the events list can be edited (date + time) or deleted, so a
// forgotten clock-out can be added after the fact, or a mistaken event can
// be corrected.
//
// Sessions panel pairs consecutive in/out events and totals their duration
// per receptionist so a manager can see "Panda worked 38h this week" without
// adding times by hand.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pencil, Trash2, Sun, Moon, X, Plus, Lock } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import { supabase } from '../../lib/supabase';
import { PinVerifyModal } from '../shared/AdminPinGate';
import {
  getAllEvents,
  updateEvent,
  deleteEvent,
  appendEvent,
  sessionsFromEvents,
  type ClockEvent,
} from '../../lib/clockLog';

type ViewRange = 'today' | 'week' | 'month' | 'all' | 'custom';

function startOfDay(d: Date): number {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}
function endOfDay(d: Date): number {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x.getTime();
}
function startOfWeek(d: Date): number {
  const x = new Date(d);
  const dow = x.getDay(); // 0 = Sun
  x.setDate(x.getDate() - dow);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}
function startOfMonth(d: Date): number {
  const x = new Date(d.getFullYear(), d.getMonth(), 1);
  return x.getTime();
}

function rangeBounds(range: ViewRange, customFrom: string, customTo: string): [number, number] {
  const now = new Date();
  switch (range) {
    case 'today':
      return [startOfDay(now), endOfDay(now)];
    case 'week':
      return [startOfWeek(now), endOfDay(now)];
    case 'month':
      return [startOfMonth(now), endOfDay(now)];
    case 'all':
      return [0, Number.MAX_SAFE_INTEGER];
    case 'custom': {
      const from = customFrom ? startOfDay(new Date(customFrom + 'T12:00')) : 0;
      const to = customTo ? endOfDay(new Date(customTo + 'T12:00')) : Number.MAX_SAFE_INTEGER;
      return [from, to];
    }
  }
}

function formatDate(ms: number): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  }).format(new Date(ms));
}
function formatTime(ms: number): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(ms));
}
function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

// Convert ms → YYYY-MM-DDTHH:MM for datetime-local input value.
function msToLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// Convert datetime-local input value → ms (assume local tz).
function localInputToMs(s: string): number {
  // The native input gives "YYYY-MM-DDTHH:MM" with no tz — new Date() parses as local.
  return new Date(s).getTime();
}

export default function ReceptionistHoursReport() {
  const { state } = useApp();
  const receptionists = useMemo(
    () => state.manicurists.filter((m) => m.isReceptionist),
    [state.manicurists],
  );

  // Reload events into local state on mount + whenever a change is made.
  // Source is the shared Supabase clock_events table, so a reload also picks
  // up clock-ins/outs made on other devices.
  const [events, setEvents] = useState<ClockEvent[]>([]);
  const reload = useCallback(async () => {
    setEvents(await getAllEvents());
  }, []);

  // Initial load.
  useEffect(() => { void reload(); }, [reload]);

  // Realtime: refresh the moment any device clocks in/out or a manager edits
  // an entry, so the hours list and totals are always current without waiting
  // for the 60s poll. Mirrors the postgres_changes pattern used elsewhere.
  useEffect(() => {
    const channel = supabase
      .channel('blueprint-clock-events-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'clock_events' }, () => {
        void reload();
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [reload]);

  // Filters
  const [staffFilter, setStaffFilter] = useState<string>('all'); // 'all' | staffId
  const [range, setRange] = useState<ViewRange>('today');
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');
  const [editing, setEditing] = useState<ClockEvent | null>(null);
  const [adding, setAdding] = useState(false);

  // Editing (add / edit / delete) is gated behind the master/admin PIN. Once a
  // manager enters it correctly, the screen stays unlocked until they navigate
  // away. `pendingAction` holds the action to run after a successful unlock.
  const [unlocked, setUnlocked] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  // Run `action` immediately if already unlocked, otherwise prompt for the
  // master PIN and run it on success.
  const guarded = useCallback((action: () => void) => {
    if (unlocked) { action(); return; }
    // Store the function itself (the updater form would call it).
    setPendingAction(() => action);
  }, [unlocked]);

  // Re-read every minute so durations stay current for still-open sessions
  // and so events from other devices appear without a manual refresh.
  useEffect(() => {
    const t = setInterval(() => { void reload(); }, 60_000);
    return () => clearInterval(t);
  }, [reload]);

  const [from, to] = useMemo(() => rangeBounds(range, customFrom, customTo), [range, customFrom, customTo]);

  // Only show events for actual receptionists. (A staff member may have been
  // demoted; those events still appear because we filter by name on the row,
  // but we exclude them from the per-staff selector to keep it clean.)
  const filtered = useMemo(() => {
    return events
      .filter((e) => e.timestamp >= from && e.timestamp <= to)
      .filter((e) => staffFilter === 'all' || e.staffId === staffFilter)
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [events, from, to, staffFilter]);

  const sessions = useMemo(() => {
    // Build sessions from the same time-filtered set so totals match the range.
    return sessionsFromEvents(
      events.filter((e) => e.timestamp >= from && e.timestamp <= to)
            .filter((e) => staffFilter === 'all' || e.staffId === staffFilter),
    );
  }, [events, from, to, staffFilter]);

  // Totals per staff for the filtered range.
  const totals = useMemo(() => {
    const map = new Map<string, { name: string; ms: number; openCount: number }>();
    for (const s of sessions) {
      const cur = map.get(s.staffId) ?? { name: s.staffName, ms: 0, openCount: 0 };
      if (s.durationMs != null) cur.ms += s.durationMs;
      if (s.durationMs == null) cur.openCount += 1;
      cur.name = s.staffName || cur.name;
      map.set(s.staffId, cur);
    }
    return Array.from(map.entries())
      .map(([staffId, v]) => ({ staffId, ...v }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [sessions]);

  return (
    <div className="p-6 overflow-y-auto h-full space-y-5">
      <div>
        <p className="font-mono text-xs text-gray-400">
          Clock-in / clock-out log for receptionists. Synced across all devices.
          {!unlocked && ' Editing requires the manager PIN.'}
        </p>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="block font-mono text-[10px] font-bold text-gray-400 tracking-wider mb-1">RECEPTIONIST</label>
          <select
            value={staffFilter}
            onChange={(e) => setStaffFilter(e.target.value)}
            className="px-3 py-2 rounded-lg border border-gray-200 font-mono text-sm bg-white focus:outline-none focus:border-gray-400"
          >
            <option value="all">All receptionists</option>
            {receptionists.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block font-mono text-[10px] font-bold text-gray-400 tracking-wider mb-1">VIEW RANGE</label>
          <div className="flex gap-1">
            {(['today', 'week', 'month', 'all', 'custom'] as ViewRange[]).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-3 py-2 rounded-lg font-mono text-[11px] font-semibold tracking-wider transition-colors ${
                  range === r ? 'bg-gray-900 text-white' : 'border border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                {r === 'today' ? 'TODAY' :
                 r === 'week' ? 'WEEK' :
                 r === 'month' ? 'MONTH' :
                 r === 'all' ? 'ALL' : 'CUSTOM'}
              </button>
            ))}
          </div>
        </div>
        {range === 'custom' && (
          <div className="flex items-end gap-2">
            <div>
              <label className="block font-mono text-[10px] font-bold text-gray-400 tracking-wider mb-1">FROM</label>
              <input
                type="date" value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="px-3 py-2 rounded-lg border border-gray-200 font-mono text-sm focus:outline-none focus:border-gray-400"
              />
            </div>
            <div>
              <label className="block font-mono text-[10px] font-bold text-gray-400 tracking-wider mb-1">TO</label>
              <input
                type="date" value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="px-3 py-2 rounded-lg border border-gray-200 font-mono text-sm focus:outline-none focus:border-gray-400"
              />
            </div>
          </div>
        )}
        <div className="ml-auto">
          <button
            onClick={() => guarded(() => setAdding(true))}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 font-mono text-xs font-bold"
          >
            {unlocked ? <Plus size={14} /> : <Lock size={14} />} ADD ENTRY
          </button>
        </div>
      </div>

      {/* Per-receptionist totals */}
      {totals.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <h3 className="font-bebas text-lg tracking-[2px] text-gray-800">TOTALS</h3>
            <p className="font-mono text-[10px] text-gray-400 mt-0.5">Sum of completed sessions in range</p>
          </div>
          <div className="divide-y divide-gray-50">
            {totals.map((t) => (
              <div key={t.staffId} className="flex items-center justify-between px-4 py-3">
                <span className="font-mono text-sm font-semibold text-gray-900">{t.name}</span>
                <div className="flex items-center gap-3">
                  {t.openCount > 0 && (
                    <span className="font-mono text-[10px] text-amber-600 bg-amber-50 px-2 py-0.5 rounded">
                      {t.openCount} open
                    </span>
                  )}
                  <span className="font-mono text-base font-bold text-gray-900">
                    {formatDuration(t.ms)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Events table */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3">
          <h3 className="font-bebas text-lg tracking-[2px] text-gray-800">ALL CLOCK ENTRIES</h3>
          <span className="font-mono text-[10px] text-gray-400">{filtered.length} entries</span>
        </div>
        {filtered.length === 0 ? (
          <div className="px-4 py-10 text-center font-mono text-xs text-gray-400">
            No clock entries in this range.
          </div>
        ) : (
          <div>
            <div className="grid grid-cols-[1fr_140px_120px_90px_90px] gap-2 px-4 py-2 bg-gray-50 border-b border-gray-100 font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">
              <span>Receptionist</span>
              <span>Date</span>
              <span>Time</span>
              <span className="text-center">Type</span>
              <span className="text-right">Actions</span>
            </div>
            {filtered.map((e) => (
              <div
                key={e.id}
                className="grid grid-cols-[1fr_140px_120px_90px_90px] gap-2 px-4 py-2.5 border-b border-gray-50 last:border-b-0 items-center"
              >
                <span className="font-mono text-sm font-semibold text-gray-900 truncate">
                  {e.staffName}
                  {e.edited && (
                    <span className="ml-2 font-mono text-[9px] text-gray-400 normal-case">(edited)</span>
                  )}
                </span>
                <span className="font-mono text-xs text-gray-600">{formatDate(e.timestamp)}</span>
                <span className="font-mono text-xs text-gray-600">{formatTime(e.timestamp)}</span>
                <span className="text-center">
                  {e.type === 'in' ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 font-mono text-[10px] font-bold tracking-wider">
                      <Sun size={10} /> IN
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 font-mono text-[10px] font-bold tracking-wider">
                      <Moon size={10} /> OUT
                    </span>
                  )}
                </span>
                <span className="flex items-center justify-end gap-1">
                  <button
                    onClick={() => guarded(() => setEditing(e))}
                    className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100"
                    title="Edit"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    onClick={() => guarded(() => {
                      if (confirm(`Delete this ${e.type === 'in' ? 'clock-in' : 'clock-out'} for ${e.staffName}?`)) {
                        void deleteEvent(e.id).then(() => reload());
                      }
                    })}
                    className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50"
                    title="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <EditEntryModal
          event={editing}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            await updateEvent(editing.id, patch);
            setEditing(null);
            await reload();
          }}
        />
      )}

      {adding && (
        <AddEntryModal
          receptionists={receptionists.map((m) => ({ id: m.id, name: m.name }))}
          onClose={() => setAdding(false)}
          onAdd={async (staffId, staffName, type, timestamp) => {
            const ev = await appendEvent(staffId, staffName, type, timestamp);
            // Mark manually-added entries as edited so they're flagged.
            if (ev) await updateEvent(ev.id, { edited: true });
            setAdding(false);
            await reload();
          }}
        />
      )}

      {/* Manager PIN gate for add / edit / delete — same master PIN as the rest
          of the app (system_state.admin_passcode). */}
      <PinVerifyModal
        isOpen={pendingAction !== null}
        title="Manager PIN"
        onCancel={() => setPendingAction(null)}
        onSuccess={() => {
          setUnlocked(true);
          const action = pendingAction;
          setPendingAction(null);
          action?.();
        }}
      />
    </div>
  );
}

// ── Edit modal ─────────────────────────────────────────────────────────────

function EditEntryModal({
  event, onClose, onSave,
}: {
  event: ClockEvent;
  onClose: () => void;
  onSave: (patch: Partial<Omit<ClockEvent, 'id'>>) => void;
}) {
  const [datetime, setDatetime] = useState(() => msToLocalInput(event.timestamp));
  const [type, setType] = useState<'in' | 'out'>(event.type);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function save() {
    const ms = localInputToMs(datetime);
    if (!Number.isFinite(ms)) return;
    onSave({ timestamp: ms, type });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-bebas text-2xl tracking-[1.5px] text-gray-900">EDIT ENTRY</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>
        <p className="font-mono text-xs text-gray-500 mb-3">
          Receptionist: <span className="font-semibold text-gray-800">{event.staffName}</span>
        </p>
        <div className="space-y-3">
          <div>
            <label className="block font-mono text-[10px] font-bold text-gray-400 tracking-wider mb-1">DATE &amp; TIME</label>
            <input
              type="datetime-local"
              value={datetime}
              onChange={(e) => setDatetime(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-gray-200 font-mono text-sm focus:outline-none focus:border-gray-400"
            />
          </div>
          <div>
            <label className="block font-mono text-[10px] font-bold text-gray-400 tracking-wider mb-1">TYPE</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setType('in')}
                className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border font-mono text-xs font-bold ${
                  type === 'in' ? 'border-amber-300 bg-amber-50 text-amber-700' : 'border-gray-200 text-gray-600'
                }`}
              >
                <Sun size={14} /> CLOCK IN
              </button>
              <button
                onClick={() => setType('out')}
                className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border font-mono text-xs font-bold ${
                  type === 'out' ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600'
                }`}
              >
                <Moon size={14} /> CLOCK OUT
              </button>
            </div>
          </div>
        </div>
        <div className="flex gap-2 mt-5">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-gray-200 text-gray-600 font-mono text-xs font-semibold"
          >
            CANCEL
          </button>
          <button
            onClick={save}
            className="flex-1 py-2.5 rounded-xl bg-gray-900 text-white font-mono text-xs font-semibold"
          >
            SAVE
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Add modal ──────────────────────────────────────────────────────────────

function AddEntryModal({
  receptionists, onClose, onAdd,
}: {
  receptionists: { id: string; name: string }[];
  onClose: () => void;
  onAdd: (staffId: string, staffName: string, type: 'in' | 'out', timestamp: number) => void;
}) {
  const [staffId, setStaffId] = useState(receptionists[0]?.id ?? '');
  const [datetime, setDatetime] = useState(() => msToLocalInput(Date.now()));
  const [type, setType] = useState<'in' | 'out'>('in');
  const [error, setError] = useState('');

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function save() {
    if (!staffId) { setError('Pick a receptionist.'); return; }
    const m = receptionists.find((r) => r.id === staffId);
    if (!m) { setError('Receptionist not found.'); return; }
    const ms = localInputToMs(datetime);
    if (!Number.isFinite(ms)) { setError('Invalid date/time.'); return; }
    onAdd(m.id, m.name, type, ms);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-bebas text-2xl tracking-[1.5px] text-gray-900">ADD ENTRY</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="block font-mono text-[10px] font-bold text-gray-400 tracking-wider mb-1">RECEPTIONIST</label>
            <select
              value={staffId}
              onChange={(e) => setStaffId(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-gray-200 font-mono text-sm bg-white focus:outline-none focus:border-gray-400"
            >
              {receptionists.length === 0 && <option value="">— None —</option>}
              {receptionists.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block font-mono text-[10px] font-bold text-gray-400 tracking-wider mb-1">DATE &amp; TIME</label>
            <input
              type="datetime-local"
              value={datetime}
              onChange={(e) => setDatetime(e.target.value)}
              className="w-full px-3 py-2 rounded-xl border border-gray-200 font-mono text-sm focus:outline-none focus:border-gray-400"
            />
          </div>
          <div>
            <label className="block font-mono text-[10px] font-bold text-gray-400 tracking-wider mb-1">TYPE</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setType('in')}
                className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border font-mono text-xs font-bold ${
                  type === 'in' ? 'border-amber-300 bg-amber-50 text-amber-700' : 'border-gray-200 text-gray-600'
                }`}
              >
                <Sun size={14} /> CLOCK IN
              </button>
              <button
                onClick={() => setType('out')}
                className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border font-mono text-xs font-bold ${
                  type === 'out' ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600'
                }`}
              >
                <Moon size={14} /> CLOCK OUT
              </button>
            </div>
          </div>
          {error && <p className="font-mono text-xs text-red-500">{error}</p>}
        </div>
        <div className="flex gap-2 mt-5">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-gray-200 text-gray-600 font-mono text-xs font-semibold"
          >
            CANCEL
          </button>
          <button
            onClick={save}
            disabled={receptionists.length === 0}
            className="flex-1 py-2.5 rounded-xl bg-gray-900 text-white font-mono text-xs font-semibold disabled:opacity-50"
          >
            ADD
          </button>
        </div>
      </div>
    </div>
  );
}
