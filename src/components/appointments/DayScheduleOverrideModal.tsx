import { useState } from 'react';
import { X } from 'lucide-react';
import type { StaffScheduleEntry, StaffScheduleOverride, Manicurist } from '../../types';

// Defaults mirror WeeklyEditorModal so the two editors feel related, but
// they are intentionally separate components — the override editor is
// scoped to ONE date, the weekly editor to the recurring blueprint.
const DEFAULT_START = '10:00';
const DEFAULT_END = '20:00';
const DEFAULT_LUNCH_START = '13:00';
const DEFAULT_LUNCH_END = '13:30';

export interface DayOverrideDraft {
  working: boolean;
  startTime: string;
  endTime: string;
  hasLunch: boolean;
  lunchStart: string;
  lunchEnd: string;
}

interface Props {
  manicurist: Manicurist;
  /** YYYY-MM-DD — the single date the override applies to. */
  date: string;
  /** Recurring weekly schedule row for the date's weekday, if any. Used
   *  to pre-fill the form when no override exists yet (the receptionist
   *  starts editing the same hours they currently see). */
  blueprint: StaffScheduleEntry | null;
  /** Existing override for (manicuristId, date) if one already exists.
   *  When set, the modal pre-fills from this row and shows the
   *  "Clear override" button. */
  existingOverride: StaffScheduleOverride | null;
  onClose: () => void;
  onSave: (draft: DayOverrideDraft) => void;
  /** Wipe the override entirely so the date falls back to the recurring
   *  blueprint. Only meaningful when existingOverride is non-null. */
  onClearOverride: () => void;
}

function formatDateLong(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(dt);
}

export default function DayScheduleOverrideModal({
  manicurist,
  date,
  blueprint,
  existingOverride,
  onClose,
  onSave,
  onClearOverride,
}: Props) {
  const [draft, setDraft] = useState<DayOverrideDraft>(() => {
    // Initial values: override > blueprint > defaults. So the modal opens
    // pre-filled with whatever the receptionist actually sees on the book
    // for this date. They tweak from there.
    if (existingOverride) {
      return {
        working: existingOverride.working,
        startTime: existingOverride.startTime,
        endTime: existingOverride.endTime,
        hasLunch: existingOverride.lunchStart !== null,
        lunchStart: existingOverride.lunchStart ?? DEFAULT_LUNCH_START,
        lunchEnd: existingOverride.lunchEnd ?? DEFAULT_LUNCH_END,
      };
    }
    if (blueprint) {
      return {
        working: true,
        startTime: blueprint.startTime,
        endTime: blueprint.endTime,
        hasLunch: blueprint.lunchStart !== null,
        lunchStart: blueprint.lunchStart ?? DEFAULT_LUNCH_START,
        lunchEnd: blueprint.lunchEnd ?? DEFAULT_LUNCH_END,
      };
    }
    return {
      working: true,
      startTime: DEFAULT_START,
      endTime: DEFAULT_END,
      hasLunch: false,
      lunchStart: DEFAULT_LUNCH_START,
      lunchEnd: DEFAULT_LUNCH_END,
    };
  });

  function update(patch: Partial<DayOverrideDraft>) {
    setDraft((prev) => {
      const next = { ...prev, ...patch };
      // Editing any field flips "OFF" back to "WORKING" — saves the
      // receptionist a click when they toggled OFF by mistake and start
      // changing times again.
      if (
        (patch.startTime || patch.endTime || patch.hasLunch || patch.lunchStart || patch.lunchEnd)
        && !next.working
      ) {
        next.working = true;
      }
      return next;
    });
  }

  function handleSave() {
    if (draft.working) {
      if (draft.endTime <= draft.startTime) {
        alert('End time must be after start time.');
        return;
      }
      if (draft.hasLunch) {
        if (draft.lunchEnd <= draft.lunchStart) {
          alert('Lunch end must be after lunch start.');
          return;
        }
        if (draft.lunchStart < draft.startTime || draft.lunchEnd > draft.endTime) {
          alert('Lunch must fall within working hours.');
          return;
        }
      }
    }
    onSave(draft);
  }

  const dateLabel = formatDateLong(date);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center px-4 py-6"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl max-w-md w-full flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between flex-shrink-0">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2.5">
              <span
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: manicurist.color }}
              />
              <h3 className="font-mono text-sm font-bold text-gray-800">
                {manicurist.name} — hours for {dateLabel}
              </h3>
            </div>
            <p className="font-mono text-[10px] text-gray-400 leading-snug">
              Just for this day. For permanent recurring changes, edit
              {' '}<span className="text-gray-500">Blueprint → Staff → Weekly Hours</span>.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 flex-shrink-0 -mr-1"
          >
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => update({ working: !draft.working })}
              className={`w-24 px-3 py-1.5 rounded-lg font-mono text-[10px] font-bold tracking-wider transition-colors ${
                draft.working
                  ? 'bg-pink-500 text-white hover:bg-pink-600'
                  : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
              }`}
            >
              {draft.working ? 'WORKING' : 'OFF TODAY'}
            </button>
            {existingOverride && (
              <span className="font-mono text-[10px] text-pink-500 tracking-wider">
                OVERRIDE ACTIVE
              </span>
            )}
          </div>

          {draft.working && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="font-mono text-[9px] font-bold text-gray-400 tracking-wider">
                    START
                  </span>
                  <input
                    type="time"
                    value={draft.startTime}
                    onChange={(e) => update({ startTime: e.target.value })}
                    className="mt-0.5 w-full px-2 py-1.5 border border-gray-200 rounded font-mono text-xs focus:outline-none focus:border-pink-300"
                  />
                </label>
                <label className="block">
                  <span className="font-mono text-[9px] font-bold text-gray-400 tracking-wider">
                    END
                  </span>
                  <input
                    type="time"
                    value={draft.endTime}
                    onChange={(e) => update({ endTime: e.target.value })}
                    className="mt-0.5 w-full px-2 py-1.5 border border-gray-200 rounded font-mono text-xs focus:outline-none focus:border-pink-300"
                  />
                </label>
              </div>
              <label className="flex items-center gap-2 cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={draft.hasLunch}
                  onChange={(e) => update({ hasLunch: e.target.checked })}
                  className="w-3.5 h-3.5 accent-pink-500"
                />
                <span className="font-mono text-[11px] font-semibold text-gray-600">
                  Block midday window (lunch / personal)
                </span>
              </label>
              {draft.hasLunch && (
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="font-mono text-[9px] font-bold text-gray-400 tracking-wider">
                      BLOCK START
                    </span>
                    <input
                      type="time"
                      value={draft.lunchStart}
                      onChange={(e) => update({ lunchStart: e.target.value })}
                      className="mt-0.5 w-full px-2 py-1.5 border border-gray-200 rounded font-mono text-xs focus:outline-none focus:border-pink-300"
                    />
                  </label>
                  <label className="block">
                    <span className="font-mono text-[9px] font-bold text-gray-400 tracking-wider">
                      BLOCK END
                    </span>
                    <input
                      type="time"
                      value={draft.lunchEnd}
                      onChange={(e) => update({ lunchEnd: e.target.value })}
                      className="mt-0.5 w-full px-2 py-1.5 border border-gray-200 rounded font-mono text-xs focus:outline-none focus:border-pink-300"
                    />
                  </label>
                </div>
              )}
            </div>
          )}

          {!draft.working && (
            <p className="font-mono text-[11px] text-gray-500 leading-snug bg-gray-50 rounded-lg p-3">
              {manicurist.name} will show as off for {dateLabel}. Their weekly blueprint hours are unchanged for every other date.
            </p>
          )}
        </div>

        <div className="px-5 py-4 bg-gray-50 border-t border-gray-100 flex items-center justify-between gap-2 flex-shrink-0">
          {existingOverride ? (
            <button
              onClick={onClearOverride}
              className="px-3 py-2 font-mono text-[10px] font-bold tracking-wider text-gray-500 hover:text-pink-600 hover:bg-pink-50 rounded-lg"
              title="Remove this day's override and fall back to the recurring weekly hours"
            >
              CLEAR OVERRIDE
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
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
              SAVE TODAY ONLY
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
