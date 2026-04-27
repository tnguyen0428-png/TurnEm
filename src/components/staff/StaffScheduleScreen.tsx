import { useMemo, useState } from 'react';
import { Trash2, Plus, X, Clock3, Pencil } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import type { StaffScheduleEntry, StaffTimeOff, Manicurist } from '../../types';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Defaults pre-filled when an admin enables a previously-off day.
const DEFAULT_START = '10:00';
const DEFAULT_END = '20:00';
const DEFAULT_LUNCH_START = '13:00';
const DEFAULT_LUNCH_END = '13:30';

function fmt12(hhmm: string): string {
  if (!hhmm || !/^\d{2}:\d{2}/.test(hhmm)) return hhmm;
  const [hStr, m] = hhmm.split(':');
  let h = Number(hStr);
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12;
  if (h === 0) h = 12;
  return m === '00' ? `${h}${ap}` : `${h}:${m}${ap}`;
}

// === Weekly grid tab ===

// Editor draft - one row per weekday (0..6). working === false means clear
// any existing schedule for that day on save.
interface DayDraft {
  working: boolean;
  startTime: string;
  endTime: string;
  hasLunch: boolean;
  lunchStart: string;
  lunchEnd: string;
}

function WeeklyTab() {
  const { state, dispatch } = useApp();
  const [editingMid, setEditingMid] = useState<string | null>(null);

  // Quick lookup: `${manicuristId}-${weekday}` -> StaffScheduleEntry
  const scheduleMap = useMemo(() => {
    const m = new Map<string, StaffScheduleEntry>();
    for (const s of state.staffSchedules) m.set(`${s.manicuristId}-${s.weekday}`, s);
    return m;
  }, [state.staffSchedules]);

  function openEditor(manicuristId: string) {
    setEditingMid(manicuristId);
  }

  return (
    <div className="p-6 overflow-y-auto h-full">
      <p className="font-mono text-xs text-gray-400 mb-4">
        Click <span className="font-semibold">Edit</span> on any technician to set hours and lunch for the entire week. Empty days = off.
      </p>

      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="grid border-b border-gray-100 bg-gray-50" style={{ gridTemplateColumns: '200px repeat(7, 1fr) 90px' }}>
          <div className="px-4 py-3 font-mono text-[10px] font-bold text-gray-400 tracking-wider">TECHNICIAN</div>
          {DAYS.map((d) => (
            <div key={d} className="py-3 text-center font-mono text-[10px] font-bold text-gray-400 tracking-wider">
              {d.toUpperCase()}
            </div>
          ))}
          <div className="py-3 text-center font-mono text-[10px] font-bold text-gray-400 tracking-wider">EDIT</div>
        </div>
        {state.manicurists.map((m, idx) => (
          <div
            key={m.id}
            className={`grid items-stretch ${idx < state.manicurists.length - 1 ? 'border-b border-gray-50' : ''}`}
            style={{ gridTemplateColumns: '200px repeat(7, 1fr) 90px' }}
          >
            <div className="px-4 py-3 flex items-center gap-2.5">
              <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: m.color }} />
              <span className="font-mono text-sm font-semibold text-gray-700 truncate">{m.name}</span>
            </div>
            {DAYS.map((_, dayIdx) => {
              const entry = scheduleMap.get(`${m.id}-${dayIdx}`);
              return (
                <button
                  key={dayIdx}
                  onClick={() => openEditor(m.id)}
                  className={`px-2 py-2 mx-1 my-1.5 rounded-lg flex flex-col items-center justify-center gap-0.5 transition-all border ${
                    entry
                      ? 'bg-pink-50 border-pink-100 hover:bg-pink-100 hover:border-pink-200 text-pink-700'
                      : 'bg-gray-50 border-gray-100 hover:bg-gray-100 text-gray-300'
                  }`}
                >
                  {entry ? (
                    <>
                      <span className="font-mono text-[11px] font-semibold leading-tight">
                        {fmt12(entry.startTime)}–{fmt12(entry.endTime)}
                      </span>
                      {entry.lunchStart && entry.lunchEnd && (
                        <span className="font-mono text-[9px] text-pink-500 leading-tight">
                          lunch {fmt12(entry.lunchStart)}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="font-mono text-xs">—</span>
                  )}
                </button>
              );
            })}
            <div className="flex items-center justify-center">
              <button
                onClick={() => openEditor(m.id)}
                className="px-2 py-1.5 bg-pink-500 hover:bg-pink-600 text-white font-mono text-[10px] font-bold tracking-wider rounded-lg flex items-center gap-1"
              >
                <Pencil size={11} /> EDIT
              </button>
            </div>
          </div>
        ))}
        {state.manicurists.length === 0 && (
          <div className="px-4 py-10 text-center font-mono text-xs text-gray-300">
            No technicians yet — add staff first.
          </div>
        )}
      </div>

      {editingMid && (
        <WeeklyEditorModal
          manicurist={state.manicurists.find((m) => m.id === editingMid)!}
          existing={state.staffSchedules.filter((s) => s.manicuristId === editingMid)}
          onClose={() => setEditingMid(null)}
          onSave={(drafts) => {
            // For each weekday, dispatch SET or CLEAR based on the draft.
            for (let wd = 0; wd < 7; wd++) {
              const d = drafts[wd];
              const prior = scheduleMap.get(`${editingMid}-${wd}`);
              if (!d.working) {
                if (prior) {
                  dispatch({ type: 'CLEAR_STAFF_SCHEDULE_DAY', manicuristId: editingMid, weekday: wd });
                }
                continue;
              }
              dispatch({
                type: 'SET_STAFF_SCHEDULE_DAY',
                entry: {
                  id: prior?.id ?? crypto.randomUUID(),
                  manicuristId: editingMid,
                  weekday: wd,
                  startTime: d.startTime,
                  endTime: d.endTime,
                  lunchStart: d.hasLunch ? d.lunchStart : null,
                  lunchEnd: d.hasLunch ? d.lunchEnd : null,
                },
              });
            }
            setEditingMid(null);
          }}
        />
      )}
    </div>
  );
}

function WeeklyEditorModal({
  manicurist, existing, onClose, onSave,
}: {
  manicurist: Manicurist;
  existing: StaffScheduleEntry[];
  onClose: () => void;
  onSave: (drafts: DayDraft[]) => void;
}) {
  const [drafts, setDrafts] = useState<DayDraft[]>(() => {
    const initial: DayDraft[] = Array.from({ length: 7 }, () => ({
      working: false,
      startTime: DEFAULT_START,
      endTime: DEFAULT_END,
      hasLunch: false,
      lunchStart: DEFAULT_LUNCH_START,
      lunchEnd: DEFAULT_LUNCH_END,
    }));
    for (const e of existing) {
      initial[e.weekday] = {
        working: true,
        startTime: e.startTime,
        endTime: e.endTime,
        hasLunch: e.lunchStart !== null,
        lunchStart: e.lunchStart ?? DEFAULT_LUNCH_START,
        lunchEnd: e.lunchEnd ?? DEFAULT_LUNCH_END,
      };
    }
    return initial;
  });

  function update(wd: number, patch: Partial<DayDraft>) {
    setDrafts((prev) => {
      const next = prev.slice();
      next[wd] = { ...next[wd], ...patch };
      if ((patch.startTime || patch.endTime || patch.hasLunch) && !next[wd].working) {
        next[wd].working = true;
      }
      return next;
    });
  }

  function applyToAll(wd: number) {
    const src = drafts[wd];
    if (!src.working) return;
    setDrafts((prev) =>
      prev.map((d, i) => (i === wd ? d : { ...src }))
    );
  }

  function handleSave() {
    for (let wd = 0; wd < 7; wd++) {
      const d = drafts[wd];
      if (!d.working) continue;
      if (d.endTime <= d.startTime) {
        alert(`${DAYS_FULL[wd]}: end time must be after start time.`);
        return;
      }
      if (d.hasLunch) {
        if (d.lunchEnd <= d.lunchStart) {
          alert(`${DAYS_FULL[wd]}: lunch end must be after lunch start.`);
          return;
        }
        if (d.lunchStart < d.startTime || d.lunchEnd > d.endTime) {
          alert(`${DAYS_FULL[wd]}: lunch must fall within working hours.`);
          return;
        }
      }
    }
    onSave(drafts);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4 py-6" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-full flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="w-3 h-3 rounded-full" style={{ backgroundColor: manicurist.color }} />
            <h3 className="font-mono text-sm font-bold text-gray-800">
              {manicurist.name} — weekly schedule
            </h3>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto flex-1">
          <div className="divide-y divide-gray-100">
            {DAYS_FULL.map((dayName, wd) => {
              const d = drafts[wd];
              return (
                <div key={wd} className="px-5 py-3">
                  <div className="flex items-center gap-3 mb-2">
                    <button
                      onClick={() => update(wd, { working: !d.working })}
                      className={`w-20 px-3 py-1.5 rounded-lg font-mono text-[10px] font-bold tracking-wider transition-colors ${
                        d.working
                          ? 'bg-pink-500 text-white hover:bg-pink-600'
                          : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                      }`}
                    >
                      {d.working ? 'WORKING' : 'OFF'}
                    </button>
                    <span className="font-mono text-sm font-semibold text-gray-700 w-24">{dayName}</span>
                    {d.working && (
                      <button
                        onClick={() => applyToAll(wd)}
                        className="ml-auto px-2 py-1 font-mono text-[10px] font-semibold text-pink-500 hover:text-pink-700 hover:bg-pink-50 rounded"
                        title="Copy this day's hours to every other day"
                      >
                        APPLY TO ALL DAYS
                      </button>
                    )}
                  </div>
                  {d.working && (
                    <div className="pl-[92px] space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <label className="block">
                          <span className="font-mono text-[9px] font-bold text-gray-400 tracking-wider">START</span>
                          <input
                            type="time"
                            value={d.startTime}
                            onChange={(e) => update(wd, { startTime: e.target.value })}
                            className="mt-0.5 w-full px-2 py-1.5 border border-gray-200 rounded font-mono text-xs focus:outline-none focus:border-pink-300"
                          />
                        </label>
                        <label className="block">
                          <span className="font-mono text-[9px] font-bold text-gray-400 tracking-wider">END</span>
                          <input
                            type="time"
                            value={d.endTime}
                            onChange={(e) => update(wd, { endTime: e.target.value })}
                            className="mt-0.5 w-full px-2 py-1.5 border border-gray-200 rounded font-mono text-xs focus:outline-none focus:border-pink-300"
                          />
                        </label>
                      </div>
                      <label className="flex items-center gap-2 cursor-pointer pt-1">
                        <input
                          type="checkbox"
                          checked={d.hasLunch}
                          onChange={(e) => update(wd, { hasLunch: e.target.checked })}
                          className="w-3.5 h-3.5 accent-pink-500"
                        />
                        <span className="font-mono text-[11px] font-semibold text-gray-600">Block lunch break</span>
                      </label>
                      {d.hasLunch && (
                        <div className="grid grid-cols-2 gap-2">
                          <label className="block">
                            <span className="font-mono text-[9px] font-bold text-gray-400 tracking-wider">LUNCH START</span>
                            <input
                              type="time"
                              value={d.lunchStart}
                              onChange={(e) => update(wd, { lunchStart: e.target.value })}
                              className="mt-0.5 w-full px-2 py-1.5 border border-gray-200 rounded font-mono text-xs focus:outline-none focus:border-pink-300"
                            />
                          </label>
                          <label className="block">
                            <span className="font-mono text-[9px] font-bold text-gray-400 tracking-wider">LUNCH END</span>
                            <input
                              type="time"
                              value={d.lunchEnd}
                              onChange={(e) => update(wd, { lunchEnd: e.target.value })}
                              className="mt-0.5 w-full px-2 py-1.5 border border-gray-200 rounded font-mono text-xs focus:outline-none focus:border-pink-300"
                            />
                          </label>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="px-5 py-4 bg-gray-50 border-t border-gray-100 flex items-center justify-end gap-2 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 font-mono text-xs font-semibold text-gray-500 hover:text-gray-700"
          >
            CANCEL
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 bg-pink-500 text-white font-mono text-xs font-semibold rounded-lg hover:bg-pink-600"
          >
            SAVE WEEK
          </button>
        </div>
      </div>
    </div>
  );
}

// === Time off tab ===

function TimeOffTab() {
  const { state, dispatch } = useApp();
  const [adding, setAdding] = useState<{
    manicuristId: string;
    startDate: string;
    endDate: string;
    reason: string;
  } | null>(null);

  const byTech = useMemo(() => {
    const m = new Map<string, StaffTimeOff[]>();
    for (const t of state.staffTimeOff) {
      const list = m.get(t.manicuristId) ?? [];
      list.push(t);
      m.set(t.manicuristId, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.startDate.localeCompare(b.startDate));
    return m;
  }, [state.staffTimeOff]);

  function openAdd(manicuristId: string) {
    const today = new Date().toISOString().slice(0, 10);
    setAdding({ manicuristId, startDate: today, endDate: today, reason: '' });
  }

  function saveAdd() {
    if (!adding) return;
    if (adding.endDate < adding.startDate) {
      alert('End date must be on or after start date.');
      return;
    }
    dispatch({
      type: 'ADD_STAFF_TIME_OFF',
      entry: {
        id: crypto.randomUUID(),
        manicuristId: adding.manicuristId,
        startDate: adding.startDate,
        endDate: adding.endDate,
        reason: adding.reason.trim(),
        createdAt: Date.now(),
      },
    });
    setAdding(null);
  }

  function deleteOne(id: string) {
    if (!confirm('Delete this time-off entry?')) return;
    dispatch({ type: 'DELETE_STAFF_TIME_OFF', id });
  }

  return (
    <div className="p-6 overflow-y-auto h-full">
      <p className="font-mono text-xs text-gray-400 mb-4">
        Vacation and PTO ranges per technician. These override the weekly schedule for the days they cover.
      </p>

      <div className="space-y-3">
        {state.manicurists.map((m) => {
          const list = byTech.get(m.id) ?? [];
          return (
            <div key={m.id} className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
              <div className="px-4 py-3 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <span className="w-3 h-3 rounded-full" style={{ backgroundColor: m.color }} />
                  <span className="font-mono text-sm font-semibold text-gray-700">{m.name}</span>
                  <span className="font-mono text-[10px] text-gray-400 ml-2">
                    {list.length === 0 ? 'no scheduled time off' : `${list.length} entr${list.length === 1 ? 'y' : 'ies'}`}
                  </span>
                </div>
                <button
                  onClick={() => openAdd(m.id)}
                  className="px-3 py-1.5 bg-pink-500 hover:bg-pink-600 text-white font-mono text-[11px] font-semibold rounded-lg flex items-center gap-1.5"
                >
                  <Plus size={12} /> ADD
                </button>
              </div>
              {list.length > 0 && (
                <div>
                  {list.map((t, idx) => (
                    <div
                      key={t.id}
                      className={`px-4 py-3 flex items-center justify-between ${idx < list.length - 1 ? 'border-b border-gray-50' : ''}`}
                    >
                      <div>
                        <div className="font-mono text-xs font-semibold text-gray-700">
                          {t.startDate}{t.startDate !== t.endDate ? ` → ${t.endDate}` : ''}
                        </div>
                        {t.reason && (
                          <div className="font-mono text-[11px] text-gray-400 mt-0.5">{t.reason}</div>
                        )}
                      </div>
                      <button
                        onClick={() => deleteOne(t.id)}
                        className="text-gray-300 hover:text-red-500"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {state.manicurists.length === 0 && (
          <div className="bg-white rounded-2xl border border-gray-100 px-4 py-10 text-center font-mono text-xs text-gray-300">
            No technicians yet — add staff first.
          </div>
        )}
      </div>

      {adding && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4" onClick={() => setAdding(null)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <h3 className="font-mono text-sm font-bold text-gray-800">Add time off</h3>
              <button onClick={() => setAdding(null)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="font-mono text-[10px] font-bold text-gray-400 tracking-wider">START DATE</span>
                  <input
                    type="date"
                    value={adding.startDate}
                    onChange={(e) => setAdding({ ...adding, startDate: e.target.value })}
                    className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg font-mono text-sm focus:outline-none focus:border-pink-300"
                  />
                </label>
                <label className="block">
                  <span className="font-mono text-[10px] font-bold text-gray-400 tracking-wider">END DATE</span>
                  <input
                    type="date"
                    value={adding.endDate}
                    onChange={(e) => setAdding({ ...adding, endDate: e.target.value })}
                    className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg font-mono text-sm focus:outline-none focus:border-pink-300"
                  />
                </label>
              </div>
              <label className="block">
                <span className="font-mono text-[10px] font-bold text-gray-400 tracking-wider">REASON (OPTIONAL)</span>
                <input
                  type="text"
                  value={adding.reason}
                  onChange={(e) => setAdding({ ...adding, reason: e.target.value })}
                  placeholder="vacation, sick, family event…"
                  className="mt-1 w-full px-3 py-2 border border-gray-200 rounded-lg font-mono text-sm focus:outline-none focus:border-pink-300"
                />
              </label>
            </div>
            <div className="px-5 py-4 bg-gray-50 border-t border-gray-100 flex items-center justify-end gap-2">
              <button onClick={() => setAdding(null)} className="px-4 py-2 font-mono text-xs font-semibold text-gray-500 hover:text-gray-700">
                CANCEL
              </button>
              <button onClick={saveAdd} className="px-4 py-2 bg-pink-500 text-white font-mono text-xs font-semibold rounded-lg hover:bg-pink-600">
                SAVE
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// === Top-level screen with tabs ===

export default function StaffScheduleScreen() {
  const [tab, setTab] = useState<'weekly' | 'timeoff'>('weekly');
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-6 pt-5 pb-3 border-b border-gray-100">
        <Clock3 size={16} className="text-pink-500" />
        <button
          onClick={() => setTab('weekly')}
          className={`px-3 py-1.5 rounded-lg font-mono text-xs font-bold tracking-wider transition-colors ${
            tab === 'weekly' ? 'bg-pink-100 text-pink-700' : 'text-gray-400 hover:text-gray-600'
          }`}
        >
          WEEKLY HOURS
        </button>
        <button
          onClick={() => setTab('timeoff')}
          className={`px-3 py-1.5 rounded-lg font-mono text-xs font-bold tracking-wider transition-colors ${
            tab === 'timeoff' ? 'bg-pink-100 text-pink-700' : 'text-gray-400 hover:text-gray-600'
          }`}
        >
          TIME OFF
        </button>
      </div>
      <div className="flex-1 overflow-hidden">
        {tab === 'weekly' ? <WeeklyTab /> : <TimeOffTab />}
      </div>
    </div>
  );
}
