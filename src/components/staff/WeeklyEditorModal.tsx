import { useState } from 'react';
import { X } from 'lucide-react';
import type { StaffScheduleEntry, Manicurist } from '../../types';

const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Defaults pre-filled when an admin enables a previously-off day.
export const DEFAULT_START = '10:00';
export const DEFAULT_END = '20:00';
export const DEFAULT_LUNCH_START = '13:00';
export const DEFAULT_LUNCH_END = '13:30';

// Editor draft - one row per weekday (0..6). working === false means clear
// any existing schedule for that day on save.
export interface DayDraft {
  working: boolean;
  startTime: string;
  endTime: string;
  hasLunch: boolean;
  lunchStart: string;
  lunchEnd: string;
}

interface Props {
  manicurist: Manicurist;
  existing: StaffScheduleEntry[];
  onClose: () => void;
  onSave: (drafts: DayDraft[]) => void;
  /** Optional: when set, the modal opens with this weekday auto-scrolled into
   *  view and visually highlighted. Used by the appointment-book overlay so a
   *  click on an off-band lands the user on the right day. */
  highlightDay?: number;
}

export default function WeeklyEditorModal({
  manicurist, existing, onClose, onSave, highlightDay,
}: Props) {
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
              {manicurist.name} \u2014 weekly schedule
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
              const isHighlighted = highlightDay === wd;
              return (
                <div
                  key={wd}
                  ref={(el) => {
                    // Auto-scroll the highlighted day into view on first render
                    if (el && isHighlighted) {
                      requestAnimationFrame(() => {
                        el.scrollIntoView({ block: 'center', behavior: 'auto' });
                      });
                    }
                  }}
                  className={`px-5 py-3 ${isHighlighted ? 'bg-pink-50 ring-2 ring-pink-300 ring-inset' : ''}`}
                >
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
