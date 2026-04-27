import { useState, useMemo } from 'react';
import {
  Clock,
  Trash2,
  User,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Save,
  CalendarDays,
  GripVertical,
  Pencil,
} from 'lucide-react';
import { useApp } from '../../state/AppContext';
import Badge, { getTurnBadgeVariant } from '../shared/Badge';
import EmptyState from '../shared/EmptyState';
import ConfirmDialog from '../shared/ConfirmDialog';
import EditCompletedModal from '../modals/EditCompletedModal';
import { formatTime, getTodayLA, getLocalDateStr } from '../../utils/time';
import type { CompletedEntry } from '../../types';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// DnD id namespacing — turns rows and service rows live in the same DndContext
// so a service row can be dragged onto a manicurist row to reassign it. The
// prefix tells handleDragEnd which kind of row was dragged.
const TURNS_ID = (id: string) => `t:${id}`;
const SERVICE_ID = (id: string) => `s:${id}`;
const parseDndId = (raw: string): { kind: 't' | 's'; id: string } | null => {
  if (raw.startsWith('t:')) return { kind: 't', id: raw.slice(2) };
  if (raw.startsWith('s:')) return { kind: 's', id: raw.slice(2) };
  return null;
};

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
    id: TURNS_ID(entry.id),
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

function groupServices(services: string[]): [string, number][] {
  const map = new Map<string, number>();
  for (const s of services) map.set(s, (map.get(s) || 0) + 1);
  return Array.from(map.entries());
}

type SortMode = 'time' | 'client' | 'manicurist';

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

// Drop target for a single completed-service entry. The "sticky hand" lives on
// the TURNS PER MANICURIST rows — dragging a manicurist row and dropping it on
// a service row reassigns that service to the dragged manicurist. The pencil
// button opens the edit modal.
function DroppableServiceRow({
  entry,
  droppable,
  onEdit,
}: {
  entry: CompletedEntry;
  droppable: boolean;
  onEdit?: (entry: CompletedEntry) => void;
}) {
  const { setNodeRef, isOver, active } = useDroppable({
    id: SERVICE_ID(entry.id),
    disabled: !droppable,
  });

  // Highlight only when a manicurist row (kind 't') is being dragged over us.
  const incomingKind = active ? parseDndId(String(active.id))?.kind : null;
  const showDropHighlight = isOver && incomingKind === 't';

  return (
    <tr
      ref={setNodeRef}
      className={`border-b border-gray-50 transition-colors ${
        showDropHighlight ? 'bg-pink-50/60' : 'hover:bg-gray-50/50'
      }`}
    >
      <td className="px-4 py-3 font-mono text-xs font-semibold text-gray-900">
        {entry.clientName}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          {groupServices(entry.services).map(([s, count]) => {
            const wasRequested =
              Array.isArray(entry.requestedServices) &&
              entry.requestedServices.length > 0 &&
              entry.requestedServices.includes(s as typeof entry.requestedServices[number]);
            return (
              <span key={s} className="inline-flex items-center gap-1">
                {wasRequested && (
                  <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white font-bold text-[9px]">
                    R
                  </span>
                )}
                <Badge
                  label={count > 1 ? `${s} x${count}` : s}
                  variant={getTurnBadgeVariant(entry.turnValue)}
                />
              </span>
            );
          })}
        </div>
      </td>
      <td className="px-4 py-3 font-mono text-xs font-bold text-gray-900">{entry.turnValue}</td>
      <td className="px-4 py-3">
        <span className="flex items-center gap-2">
          <span
            className="w-2.5 h-2.5 rounded-full"
            style={{ backgroundColor: entry.manicuristColor }}
          />
          <span className="font-mono text-xs font-bold text-gray-900">{entry.manicuristName}</span>
        </span>
      </td>
      <td className="pr-3 pl-1 py-3 w-10 text-right">
        {onEdit && (
          <button
            onClick={() => onEdit(entry)}
            type="button"
            aria-label="Edit service"
            className="p-1.5 rounded-lg text-gray-300 hover:text-gray-900 hover:bg-gray-100 transition-colors"
          >
            <Pencil size={14} />
          </button>
        )}
      </td>
    </tr>
  );
}

interface HistoryTableProps {
  entries: CompletedEntry[];
  droppable: boolean;
  onEdit?: (entry: CompletedEntry) => void;
}

function HistoryTable({ entries, droppable, onEdit }: HistoryTableProps) {
  const [sortMode, setSortMode] = useState<SortMode>('time');
  const [manicuristFilter, setManicuristFilter] = useState<string>('all');

  const manicuristNames = useMemo(() => {
    const fromEntries = entries.map((c) => c.manicuristName);
    return Array.from(new Set(fromEntries)).sort();
  }, [entries]);

  const sortedEntries = useMemo(() => {
    let list = [...entries];
    if (manicuristFilter !== 'all') {
      list = list.filter((c) => c.manicuristName === manicuristFilter);
    }
    if (sortMode === 'time') {
      list.sort((a, b) => b.completedAt - a.completedAt);
    } else if (sortMode === 'client') {
      list.sort((a, b) => a.clientName.localeCompare(b.clientName));
    } else {
      list.sort((a, b) => a.manicuristName.localeCompare(b.manicuristName) || b.completedAt - a.completedAt);
    }
    return list;
  }, [entries, sortMode, manicuristFilter]);

  return (
    <>
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[10px] text-gray-400 tracking-wider font-semibold">SORT</span>
            <div className="flex rounded-lg border border-gray-200 overflow-hidden">
              {(['time', 'client', 'manicurist'] as SortMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setSortMode(mode)}
                  className={`flex items-center gap-1 px-2.5 py-1.5 font-mono text-[10px] font-semibold transition-colors ${
                    sortMode === mode
                      ? 'bg-gray-900 text-white'
                      : 'text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  {mode === 'time' && <Clock size={10} />}
                  {mode === 'client' && <User size={10} />}
                  {mode === 'manicurist' && <CalendarDays size={10} />}
                  {mode.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          {manicuristNames.length > 1 && (
            <div className="flex items-center gap-1.5 relative">
              <span className="font-mono text-[10px] text-gray-400 tracking-wider font-semibold">FILTER</span>
              <div className="relative">
                <select
                  value={manicuristFilter}
                  onChange={(e) => setManicuristFilter(e.target.value)}
                  className="appearance-none pl-2.5 pr-7 py-1.5 rounded-lg border border-gray-200 font-mono text-[10px] font-semibold text-gray-700 bg-white focus:outline-none focus:border-gray-400 cursor-pointer"
                >
                  <option value="all">ALL STAFF</option>
                  {manicuristNames.map((n) => (
                    <option key={n} value={n}>{n.toUpperCase()}</option>
                  ))}
                </select>
                <ChevronDown size={10} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
              </div>
            </div>
          )}
          <span className="ml-auto font-mono text-[10px] text-gray-400">{sortedEntries.length} entries</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="text-left px-4 py-3 font-mono text-xs text-gray-900 tracking-wider font-bold">CLIENT</th>
                <th className="text-left px-4 py-3 font-mono text-xs text-gray-900 tracking-wider font-bold">SERVICE</th>
                <th className="text-left px-4 py-3 font-mono text-xs text-gray-900 tracking-wider font-bold">TURNS</th>
                <th className="text-left px-4 py-3 font-mono text-xs text-gray-900 tracking-wider font-bold">MANICURIST</th>
                <th className="w-10" aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {sortedEntries.map((entry) => (
                <DroppableServiceRow
                  key={entry.id}
                  entry={entry}
                  droppable={droppable}
                  onEdit={onEdit}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

export default function HistoryScreen() {
  const { state, dispatch, saveTodayHistory } = useApp();
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
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

  const displayedEntries = viewingPastDay && pastDayEntries !== null
    ? pastDayEntries
    : state.completed.length > 0
      ? state.completed
      : (todayArchivedEntries ?? []);

  // Per-manicurist turn totals — shown whenever manicurists are clocked in,
  // even before any services complete. For today, ordered by clock-in time
  // (which doubles as the priority order — drag to reorder swaps clockInTimes).
  const turnsPerManicurist = useMemo<TurnsRowEntry[]>(() => {
    if (!viewingPastDay) {
      const clockedIn = state.manicurists
        .filter((m) => m.clockedIn)
        .sort((a, b) => (a.clockInTime ?? Infinity) - (b.clockInTime ?? Infinity));
      if (clockedIn.length > 0) {
        return clockedIn.map((m) => ({
          id: m.id,
          name: m.name,
          turns: m.totalTurns,
          color: m.color,
          clockInTime: m.clockInTime ? formatTime(m.clockInTime) : '',
        }));
      }
    }
    // Past day view or everyone clocked out: build from displayed entries
    const map = new Map<string, TurnsRowEntry>();
    for (const e of displayedEntries) {
      if (!map.has(e.manicuristId)) {
        map.set(e.manicuristId, {
          id: e.manicuristId,
          name: e.manicuristName,
          turns: 0,
          color: e.manicuristColor,
          clockInTime: '',
        });
      }
      map.get(e.manicuristId)!.turns += e.turnValue;
    }
    return Array.from(map.values());
  }, [viewingPastDay, state.manicurists, displayedEntries]);

  const maxTurns = useMemo(
    () => Math.max(1, ...turnsPerManicurist.map((e) => e.turns)),
    [turnsPerManicurist]
  );

  // Drag is only meaningful for clocked-in manicurists today (since reordering
  // works by swapping clockInTime values, which only exist for clocked-in staff).
  const turnsDraggable = !viewingPastDay && state.manicurists.some((m) => m.clockedIn);

  // Service rows are drop targets on today's view — the user drags a manicurist
  // row from TURNS PER MANICURIST onto a service row to reassign that entry to
  // them. Disabled on past-day views since the day has already been archived.
  const serviceRowsDroppable = !viewingPastDay;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeKind = parseDndId(String(active.id));
    const overKind = parseDndId(String(over.id));
    if (!activeKind || !overKind) return;

    // ── Reorder turns rows (manicurist priority order) ──────────────────────
    if (activeKind.kind === 't' && overKind.kind === 't') {
      if (!turnsDraggable) return;
      const ids = turnsPerManicurist.map((e) => e.id);
      const oldIndex = ids.indexOf(activeKind.id);
      const newIndex = ids.indexOf(overKind.id);
      if (oldIndex < 0 || newIndex < 0) return;

      const newOrder = arrayMove(ids, oldIndex, newIndex);
      const originalTimes = turnsPerManicurist.map(
        (e) => state.manicurists.find((m) => m.id === e.id)?.clockInTime ?? null
      );
      newOrder.forEach((id, i) => {
        dispatch({ type: 'UPDATE_MANICURIST', id, updates: { clockInTime: originalTimes[i] } });
      });
      return;
    }

    // ── Reassign a service entry by dropping a manicurist row onto it ──────
    // The "sticky hand" lives on the TURNS PER MANICURIST rows — dragging one
    // onto a service row credits that service's turns to the dragged manicurist.
    if (activeKind.kind === 't' && overKind.kind === 's') {
      if (!serviceRowsDroppable) return;
      const entry = displayedEntries.find((e) => e.id === overKind.id);
      const newManicurist = state.manicurists.find((m) => m.id === activeKind.id);
      if (!entry || !newManicurist) return;
      if (entry.manicuristId === newManicurist.id) return;
      dispatch({
        type: 'UPDATE_COMPLETED',
        id: entry.id,
        updates: {
          manicuristId: newManicurist.id,
          manicuristName: newManicurist.name,
          manicuristColor: newManicurist.color,
        },
      });
    }
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
    setSelectedDate(dateStr === selectedDate ? null : dateStr);
    setShowCalendar(false);
  }

  return (
    <div className="h-full overflow-y-auto">
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
              {serviceRowsDroppable && (
                <span className="font-mono text-[9px] text-pink-500 border border-pink-200 bg-pink-50 rounded-full px-2 py-0.5 tracking-wider">
                  OR DROP ON A SERVICE TO REASSIGN
                </span>
              )}
            </div>
            <SortableContext
              items={turnsPerManicurist.map((e) => TURNS_ID(e.id))}
              strategy={verticalListSortingStrategy}
            >
              <div className="flex flex-col gap-1.5">
                {turnsPerManicurist.map((entry) => (
                  <SortableTurnsRow
                    key={entry.id}
                    entry={entry}
                    maxTurns={maxTurns}
                    draggable={turnsDraggable}
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
            droppable={serviceRowsDroppable}
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
            dispatch({ type: 'CLEAR_HISTORY' });
            setShowClearConfirm(false);
          }}
          onCancel={() => setShowClearConfirm(false)}
        />
      )}
    </div>
    </div>
  );
}
