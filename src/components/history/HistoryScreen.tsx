import { useState, useMemo, useEffect } from 'react';
import {
  Clock,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Save,
  CalendarDays,
  GripVertical,
} from 'lucide-react';
import { useApp } from '../../state/AppContext';
import HistoryTable from './HistoryTable';
import { buildInServiceEntries } from '../../lib/todayEntries';
import EmptyState from '../shared/EmptyState';
import ConfirmDialog from '../shared/ConfirmDialog';
import { PinVerifyModal } from '../shared/AdminPinGate';
import EditCompletedModal from '../modals/EditCompletedModal';
import { formatTime, getTodayLA, getLocalDateStr } from '../../utils/time';
import type { CompletedEntry } from '../../types';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// ─── Sortable turns row ──────────────────────────────────────────────────────

interface TurnsRowEntry {
  id: string;
  name: string;
  turns: number;
  color: string;
  clockInTime: string;
}

function SortableTurnsRow({
  entry,
  maxTurns,
  draggable,
}: {
  entry: TurnsRowEntry;
  maxTurns: number;
  draggable: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.id,
    disabled: !draggable,
  });

  const widthPct = maxTurns > 0 ? Math.max((entry.turns / maxTurns) * 100, entry.turns > 0 ? 4 : 0) : 0;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-3 px-3 py-2 bg-white rounded-xl border transition-all duration-150 ${
        isDragging
          ? 'opacity-40 shadow-lg border-pink-300'
          : 'border-gray-100 hover:border-gray-200'
      }`}
    >
      {draggable ? (
        <button
          {...attributes}
          {...listeners}
          className="touch-none flex-shrink-0 text-gray-300 hover:text-pink-400 cursor-grab active:cursor-grabbing"
          tabIndex={-1}
          aria-label="Drag to reorder"
        >
          <GripVertical size={14} />
        </button>
      ) : (
        <span className="w-[14px] flex-shrink-0" />
      )}

      <span
        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
        style={{ backgroundColor: entry.color }}
      />

      <div className="w-24 flex-shrink-0 min-w-0">
        <p className="font-mono text-xs font-bold text-gray-900 truncate leading-tight">
          {entry.name}
        </p>
        {entry.clockInTime && (
          <p className="font-mono text-[9px] text-gray-400 truncate leading-tight">
            {entry.clockInTime}
          </p>
        )}
      </div>

      <div className="flex-1 h-5 rounded-md overflow-hidden bg-gray-50 min-w-0">
        <div
          className="h-full rounded-md transition-all duration-200"
          style={{ width: `${widthPct}%`, backgroundColor: entry.color }}
        />
      </div>

      <span className="font-mono text-xs font-semibold text-gray-700 w-10 text-right flex-shrink-0">
        {entry.turns.toFixed(1)}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function getTodayDateStr(): string {
  return getTodayLA();
}

function getMonthDays(year: number, month: number): Date[] {
  const days: Date[] = [];
  const last = new Date(year, month + 1, 0);
  for (let d = 1; d <= last.getDate(); d++) {
    days.push(new Date(year, month, d));
  }
  return days;
}

function formatDateDisplay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function HistoryScreen() {
  const { state, dispatch, saveTodayHistory } = useApp();
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showClearPin, setShowClearPin] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  // Browsing a PAST day is gated behind the master PIN (Tony 2026-08-31).
  // Today's history stays open to everyone — that is the working view the
  // front desk needs all shift. Only looking BACK is restricted.
  //
  // The unlock lasts for as long as this screen stays mounted: whoever is
  // reviewing past days is usually stepping through several of them, and a
  // PIN prompt per day would train people to keep the master PIN on a sticky
  // note by the till, which is worse for security than one prompt. Leaving
  // History re-locks it.
  const [pastUnlocked, setPastUnlocked] = useState(false);
  const [pendingPastDate, setPendingPastDate] = useState<string | null>(null);
  // Re-lock the moment the view returns to today, by any route — the back
  // button, the calendar's today cell, or deselecting the current day. The
  // unlock is meant to carry someone THROUGH a review of past days, not to
  // leave the past standing open on an unattended tablet afterwards. Combined
  // with the unmount reset, the window in which it stays unlocked is exactly
  // "a past day is on screen".
  useEffect(() => {
    if (selectedDate === null && pastUnlocked) setPastUnlocked(false);
  }, [selectedDate, pastUnlocked]);
  const [editingEntry, setEditingEntry] = useState<CompletedEntry | null>(null);
  const today = getTodayDateStr();
  const todayAlreadySaved = state.dailyHistory.some((h) => h.date === today);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });

  const datesWithHistory = useMemo(() => {
    return new Set(state.dailyHistory.map((d) => d.date));
  }, [state.dailyHistory]);

  const viewingPastDay = selectedDate !== null && selectedDate !== today;
  const pastDayEntries = useMemo(() => {
    if (!viewingPastDay || !selectedDate) return null;
    return state.dailyHistory.find((d) => d.date === selectedDate)?.entries ?? null;
  }, [viewingPastDay, selectedDate, state.dailyHistory]);

  // If today's in-memory completed list is empty (e.g. after end-of-day reset),
  // fall back to today's saved dailyHistory entry so history is never blank.
  const todayArchivedEntries = useMemo(() => {
    if (state.completed.length > 0) return null;
    return state.dailyHistory.find((d) => d.date === today)?.entries ?? null;
  }, [state.completed, state.dailyHistory, today]);

  // In-flight rows are only meaningful for today's view — past days have no
  // live queue. Derivation lives in lib/todayEntries so the queue's CLOCK-IN
  // LIST table builds its rows the exact same way.
  const inServiceEntries = useMemo<CompletedEntry[]>(
    () => (viewingPastDay ? [] : buildInServiceEntries(state.queue, state.manicurists)),
    [viewingPastDay, state.queue, state.manicurists],
  );

  const displayedEntries = viewingPastDay && pastDayEntries !== null
    ? pastDayEntries.filter((e) => !e.voided)
    : [
        ...inServiceEntries,
        ...(state.completed.length > 0 ? state.completed : (todayArchivedEntries ?? []))
          .filter((e) => !e.voided),
      ];

  // Per-manicurist turn totals.
  //
  // For TODAY:
  //   - Include every manicurist currently clocked IN AND every manicurist
  //     who already did at least one service today (so the list doesn't lose
  //     people mid-day when they clock out).
  //   - Sort EVERYONE by clock-in time so the chronological order is
  //     preserved even after someone clocks out. Clocked-in rows use
  //     their live `clockInTime`; clocked-out rows fall back to the
  //     earliest `startedAt` from their displayedEntries today (the time
  //     of their first completed service is the best proxy for when they
  //     were working).
  //   - TURN COUNT IS SINGLE-SOURCE: each row's number is the sum of that
  //     tech's non-voided entries in `displayedEntries` (completed rows PLUS
  //     in-service synthetic rows) — NOT the separate live `total_turns`
  //     counter. The two were maintained independently and drifted apart
  //     (6/18 Mia/Christina/Ly); deriving the count straight from the records
  //     it sits above keeps the number and the service list in lockstep.
  //
  // For PAST DAYS: build entirely from the day's saved entries.
  const turnsPerManicurist = useMemo<TurnsRowEntry[]>(() => {
    if (!viewingPastDay) {
      type Row = TurnsRowEntry & { sortTime: number; hasClockIn: boolean };
      const byId = new Map<string, Row>();

      // 1. Every manicurist who clocked in today (whether currently clocked
      //    in or already clocked out) — clockInTime is the stable sort key.
      //    Keeping clocked-out staff in this pass with their original
      //    clockInTime as sortTime stops the row from reshuffling later in
      //    the day when someone clocks out (the prior fallback was earliest
      //    `startedAt` from entries, which is a different value).
      //    The displayed clockInTime string is only set for currently
      //    clocked-in rows; clocked-out rows show no time chip, and the
      //    empty-string sentinel below also tells step 2 to sum entry turns
      //    into their row (clocked-in rows already have live totalTurns).
      for (const m of state.manicurists) {
        if (m.clockInTime === null) continue;
        byId.set(m.id, {
          id: m.id,
          name: m.name,
          turns: 0,
          color: m.color,
          clockInTime: m.clockedIn ? formatTime(m.clockInTime) : '',
          sortTime: m.clockInTime,
          hasClockIn: true,
        });
      }

      // 2. Add / fold in entries — covers manicurists with no clock-in
      //    record at all (legacy/orphan entries), and gives THOSE rows a
      //    sortTime from their earliest startedAt. Rows already seeded in
      //    step 1 keep clockInTime as their sortTime unconditionally — a
      //    ticket's startedAt can occasionally land a few seconds before
      //    the clock-in stamp (e.g. Brian 2026-08-02: ticket started 9s
      //    before his official clock-in), and letting that startedAt pull
      //    sortTime earlier anchored his row above manicurists with a
      //    later clockInTime in a way dragging (which only swaps
      //    clockInTime, see handleDragEnd) could never override — every
      //    attempt to drag someone above him snapped back.
      for (const e of displayedEntries) {
        const startTime = e.startedAt ?? Number.POSITIVE_INFINITY;
        if (!byId.has(e.manicuristId)) {
          byId.set(e.manicuristId, {
            id: e.manicuristId,
            name: e.manicuristName,
            turns: 0,
            color: e.manicuristColor,
            clockInTime: '',
            sortTime: startTime,
            hasClockIn: false,
          });
        }
        // SINGLE-SOURCE turn count: sum every non-voided entry for EVERY row —
        // clocked-in and clocked-out alike. displayedEntries already contains
        // both the completed rows AND the in-service synthetic rows, so this
        // sum equals completed + in-progress without reading the live
        // total_turns counter (which drifted out of sync with the records on
        // 6/18 — Mia/Christina/Ly). The count now always equals the service
        // list rendered beneath it.
        const existing = byId.get(e.manicuristId)!;
        if (!e.voided) {
          existing.turns += e.turnValue;
        }
      }

      if (byId.size > 0) {
        return Array.from(byId.values())
          .sort((a, b) => a.sortTime - b.sortTime)
          .map(({ sortTime: _t, hasClockIn: _h, ...rest }) => { void _t; void _h; return rest; });
      }
    }
    // Past day view (or today with no data at all): build from displayed entries.
    // Order is FROZEN to the clock-in sequence captured when the day was saved
    // (CompletedEntry.manicuristClockInTime), so the line-up is replayed exactly
    // as it stood — never re-derived from the live roster or re-sorted by
    // anything else. Legacy entries from before that field existed carry no
    // stamp (sortKey stays Infinity); because the sort is stable, those days
    // keep their original saved (first-appearance) order untouched.
    type PastRow = TurnsRowEntry & { sortKey: number };
    const map = new Map<string, PastRow>();
    for (const e of displayedEntries) {
      if (!map.has(e.manicuristId)) {
        map.set(e.manicuristId, {
          id: e.manicuristId,
          name: e.manicuristName,
          turns: 0,
          color: e.manicuristColor,
          clockInTime: '',
          sortKey: Number.POSITIVE_INFINITY,
        });
      }
      const row = map.get(e.manicuristId)!;
      if (!e.voided) row.turns += e.turnValue;
      const t = e.manicuristClockInTime;
      if (typeof t === 'number' && t < row.sortKey) row.sortKey = t;
    }
    return Array.from(map.values())
      .sort((a, b) => a.sortKey - b.sortKey)
      .map(({ sortKey: _k, ...rest }) => { void _k; return rest; });
  }, [viewingPastDay, state.manicurists, displayedEntries]);

  const maxTurns = useMemo(
    () => Math.max(1, ...turnsPerManicurist.map((e) => e.turns)),
    [turnsPerManicurist]
  );

  // Drag is only meaningful for clocked-in manicurists today (since reordering
  // works by swapping clockInTime values, which only exist for clocked-in staff).
  const turnsDraggable = !viewingPastDay && state.manicurists.some((m) => m.clockedIn);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    if (!turnsDraggable) return;

    // Both source and destination must be currently clocked-in rows.
    // Clocked-out rows linger in the list to preserve today's history but
    // have no clockInTime — swapping a real time with null would clobber
    // the priority order (and effectively re-clock-out a working manicurist).
    const activeMan = state.manicurists.find((m) => m.id === String(active.id));
    const overMan = state.manicurists.find((m) => m.id === String(over.id));
    if (!activeMan?.clockedIn || !overMan?.clockedIn) return;

    // Reorder operates only on the clocked-in subset of the displayed
    // list — swap the clockInTimes so the manicurist priority order on
    // today's queue follows the new visual order.
    const clockedInIds = turnsPerManicurist
      .filter((e) => !!e.clockInTime)
      .map((e) => e.id);
    const oldIndex = clockedInIds.indexOf(String(active.id));
    const newIndex = clockedInIds.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;

    const newOrder = arrayMove(clockedInIds, oldIndex, newIndex);
    const originalTimes = clockedInIds.map(
      (id) => state.manicurists.find((m) => m.id === id)?.clockInTime ?? null
    );
    newOrder.forEach((id, i) => {
      dispatch({ type: 'UPDATE_MANICURIST', id, updates: { clockInTime: originalTimes[i] } });
    });
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(false);
    const success = await saveTodayHistory();
    setSaving(false);
    if (!success) setSaveError(true);
  }

  const monthDays = getMonthDays(calendarMonth.year, calendarMonth.month);
  const firstDayOfWeek = new Date(calendarMonth.year, calendarMonth.month, 1).getDay();

  function prevMonth() {
    setCalendarMonth((p) => {
      const m = p.month - 1;
      return m < 0 ? { year: p.year - 1, month: 11 } : { year: p.year, month: m };
    });
  }

  function nextMonth() {
    setCalendarMonth((p) => {
      const m = p.month + 1;
      return m > 11 ? { year: p.year + 1, month: 0 } : { year: p.year, month: m };
    });
  }

  function selectDate(dateStr: string) {
    // Deselecting back to today is never gated — that is closing the past,
    // not opening it.
    if (dateStr === selectedDate) {
      setSelectedDate(null);
      setShowCalendar(false);
      return;
    }
    if (dateStr < today && !pastUnlocked) {
      setPendingPastDate(dateStr);
      return;
    }
    setSelectedDate(dateStr);
    setShowCalendar(false);
  }

  return (
    <div className="absolute inset-0 overflow-y-auto">
    <div className="max-w-5xl mx-auto p-4 sm:p-6">

      <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <h2 className="font-bebas text-2xl tracking-[3px] text-gray-900">
            {selectedDate && selectedDate !== today ? formatDateDisplay(selectedDate).toUpperCase() : "TODAY'S HISTORY"}
          </h2>
          {selectedDate && selectedDate !== today && (
            <button
              onClick={() => setSelectedDate(null)}
              className="font-mono text-[10px] text-gray-400 hover:text-gray-700 transition-colors border border-gray-200 rounded-lg px-2 py-1"
            >
              BACK TO TODAY
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!viewingPastDay && state.completed.length > 0 && (
            <button
              onClick={handleSave}
              disabled={saving}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl border-2 font-mono text-xs font-semibold transition-colors disabled:opacity-50 ${
                saveError
                  ? 'border-red-300 text-red-600 hover:bg-red-50'
                  : 'border-emerald-200 text-emerald-600 hover:bg-emerald-50'
              }`}
            >
              <Save size={14} />
              {saving ? 'SAVING...' : saveError ? 'SAVE FAILED — RETRY' : 'SAVE TODAY'}
            </button>
          )}
          <button
            onClick={() => setShowCalendar((v) => !v)}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl border-2 font-mono text-xs font-semibold transition-colors ${
              showCalendar
                ? 'border-gray-900 bg-gray-900 text-white'
                : 'border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            <CalendarDays size={14} />
            BROWSE DAYS
          </button>
          {!viewingPastDay && state.completed.length > 0 && (
            <button
              onClick={() => setShowClearConfirm(true)}
              disabled={!todayAlreadySaved}
              title={!todayAlreadySaved ? 'Save today first before clearing' : "Clear today's history"}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl border-2 font-mono text-xs font-semibold transition-colors ${
                !todayAlreadySaved
                  ? 'border-gray-200 text-gray-300 cursor-not-allowed'
                  : 'border-red-200 text-red-500 hover:bg-red-50'
              }`}
            >
              <Trash2 size={14} />
              CLEAR
            </button>
          )}
        </div>
      </div>

      {showCalendar && (
        <div className="bg-white rounded-2xl border border-gray-100 p-5 mb-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <button
              onClick={prevMonth}
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 transition-colors text-gray-500"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="font-bebas tracking-[2px] text-gray-900 text-lg">
              {MONTH_NAMES[calendarMonth.month]} {calendarMonth.year}
            </span>
            <button
              onClick={nextMonth}
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 transition-colors text-gray-500"
            >
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="grid grid-cols-7 mb-1">
            {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => (
              <div key={d} className="text-center font-mono text-[10px] text-gray-400 py-1">{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {Array.from({ length: firstDayOfWeek }).map((_, i) => (
              <div key={`empty-${i}`} />
            ))}
            {monthDays.map((day) => {
              const dateStr = getLocalDateStr(day);
              const isToday = dateStr === today;
              const hasSavedHistory = datesWithHistory.has(dateStr);
              const isSelected = dateStr === selectedDate;
              const isPast = dateStr < today;
              const isFuture = dateStr > today;

              return (
                <button
                  key={dateStr}
                  onClick={() => {
                    if (isToday) {
                      setSelectedDate(null);
                      setShowCalendar(false);
                    } else if (hasSavedHistory) {
                      selectDate(dateStr);
                    }
                  }}
                  disabled={isFuture || (!hasSavedHistory && !isToday)}
                  className={`
                    relative aspect-square flex flex-col items-center justify-center rounded-xl text-xs font-mono font-semibold transition-all
                    ${isSelected ? 'bg-gray-900 text-white' : ''}
                    ${isToday && !isSelected ? 'bg-pink-50 text-pink-600 border-2 border-pink-200' : ''}
                    ${hasSavedHistory && !isSelected && !isToday ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 cursor-pointer' : ''}
                    ${isPast && !hasSavedHistory && !isToday ? 'text-gray-300 cursor-not-allowed' : ''}
                    ${isFuture ? 'text-gray-200 cursor-not-allowed' : ''}
                  `}
                >
                  {day.getDate()}
                  {hasSavedHistory && !isSelected && (
                    <span className="absolute bottom-1 w-1 h-1 rounded-full bg-emerald-500" />
                  )}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-4 mt-4 pt-3 border-t border-gray-100">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded bg-pink-50 border-2 border-pink-200" />
              <span className="font-mono text-[10px] text-gray-400">TODAY</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded bg-emerald-50" />
              <span className="font-mono text-[10px] text-gray-400">HAS HISTORY</span>
            </div>
          </div>
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        {turnsPerManicurist.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-100 p-4 mb-6">
            <div className="flex items-center gap-2 mb-3">
              <h3 className="font-bebas text-xl tracking-[2px] text-gray-900 font-bold">TURNS PER MANICURIST</h3>
              {turnsDraggable && (
                <span className="font-mono text-[9px] text-gray-400 border border-gray-200 rounded-full px-2 py-0.5 tracking-wider">
                  DRAG TO REORDER
                </span>
              )}
            </div>
            <SortableContext
              items={turnsPerManicurist.map((e) => e.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="flex flex-col gap-1.5">
                {turnsPerManicurist.map((entry) => (
                  <SortableTurnsRow
                    key={entry.id}
                    entry={entry}
                    maxTurns={maxTurns}
                    // Only allow dragging rows whose manicurist is still
                    // clocked in — clocked-out rows have no clockInTime to
                    // swap, so reordering them is meaningless.
                    draggable={turnsDraggable && !!entry.clockInTime}
                  />
                ))}
              </div>
            </SortableContext>
          </div>
        )}

        {displayedEntries.length === 0 ? (
          <EmptyState
            icon={<Clock size={48} />}
            title={viewingPastDay ? 'No history for this day' : 'No services completed yet'}
            description={viewingPastDay ? 'No records were saved for this date' : 'Completed services will appear here'}
          />
        ) : (
          <HistoryTable
            entries={displayedEntries}
            onEdit={!viewingPastDay ? setEditingEntry : undefined}
          />
        )}
      </DndContext>

      {editingEntry && (
        <EditCompletedModal entry={editingEntry} onClose={() => setEditingEntry(null)} />
      )}

      {showClearConfirm && (
        <ConfirmDialog
          message={!todayAlreadySaved
            ? "Today's data has NOT been saved. Clearing will permanently lose all services. Save first!"
            : "Clear all history? This will reset today's completed services."
          }
          confirmLabel="Clear All"
          danger
          onConfirm={() => {
            // Require the admin PIN before clearing — a plain confirm was too
            // easy to trigger accidentally and wiped a full day of turns.
            setShowClearConfirm(false);
            setShowClearPin(true);
          }}
          onCancel={() => setShowClearConfirm(false)}
        />
      )}

      <PinVerifyModal
        isOpen={pendingPastDate !== null}
        gate="history:previous-day"
        detail={pendingPastDate ?? undefined}
        title="Enter Admin PIN to view previous days"
        onSuccess={() => {
          setPastUnlocked(true);
          setSelectedDate(pendingPastDate);
          setPendingPastDate(null);
          setShowCalendar(false);
        }}
        onCancel={() => setPendingPastDate(null)}
      />

      <PinVerifyModal
        isOpen={showClearPin}
        gate="history:clear"
        title="Enter Admin PIN to Clear"
        onSuccess={() => {
          dispatch({ type: 'CLEAR_HISTORY' });
          setShowClearPin(false);
        }}
        onCancel={() => setShowClearPin(false)}
      />
    </div>
    </div>
  );
}
