import { useState, useMemo, useEffect } from 'react';
import { Clock, Trash2, User, ChevronDown, ChevronLeft, ChevronRight, Save, CalendarDays, GripVertical, Pencil, Check, X } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { useApp } from '../../state/AppContext';
import Badge, { getTurnBadgeVariant } from '../shared/Badge';
import EmptyState from '../shared/EmptyState';
import ConfirmDialog from '../shared/ConfirmDialog';
import { formatTime, getTodayLA, getLocalDateStr } from '../../utils/time';
import type { CompletedEntry, Manicurist } from '../../types';
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
import type React from 'react';

/** Convert a timestamp to "HH:MM" (24h) for <input type="time"> */
function timestampToTimeInput(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

/** Convert "HH:MM" from <input type="time"> to today's timestamp */
function timeInputToTimestamp(val: string): number | null {
  const parts = val.split(':').map(Number);
  if (parts.length < 2 || parts.some(isNaN)) return null;
  const [hours, minutes] = parts;
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0, 0).getTime();
}

// âââ Sortable clock-in row ââââââââââââââââââââââââââââââââââââââââââââââââââââ

interface SortableClockInRowProps {
  manicurist: Pick<Manicurist, 'id' | 'name' | 'color' | 'clockInTime'>;
  editingId: string | null;
  editValue: string;
  onStartEdit: (id: string) => void;
  onChangeEdit: (val: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
}

function SortableClockInRow({
  manicurist,
  editingId,
  editValue,
  onStartEdit,
  onChangeEdit,
  onSaveEdit,
  onCancelEdit,
}: SortableClockInRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: manicurist.id,
  });

  const isEditing = editingId === manicurist.id;

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') onSaveEdit();
    if (e.key === 'Escape') onCancelEdit();
  }

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-3 px-3 py-2.5 bg-white rounded-xl border transition-all duration-150 ${
        isDragging
          ? 'opacity-40 shadow-lg border-pink-300'
          : 'border-gray-100 hover:border-gray-200'
      }`}
    >
      {/* drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="touch-none flex-shrink-0 text-gray-300 hover:text-pink-400 cursor-grab active:cursor-grabbing"
        tabIndex={-1}
        aria-label="Drag to reorder"
      >
        <GripVertical size={14} />
      </button>

      {/* color dot + name */}
      <span
        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
        style={{ backgroundColor: manicurist.color }}
      />
      <span className="font-mono text-xs font-bold text-gray-900 flex-1 min-w-0 truncate">
        {manicurist.name}
      </span>

      {/* clock-in time â editable */}
      {isEditing ? (
        <div className="flex items-center gap-1.5">
          <input
            type="time"
            value={editValue}
            onChange={(e) => onChangeEdit(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
            className="font-mono text-xs border border-pink-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-pink-200"
          />
          <button
            onClick={onSaveEdit}
            className="w-6 h-6 flex items-center justify-center rounded-lg bg-emerald-100 hover:bg-emerald-200 text-emerald-700 transition-colors"
          >
            <Check size={11} />
          </button>
          <button
            onClick={onCancelEdit}
            className="w-6 h-6 flex items-center justify-center rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-500 transition-colors"
          >
            <X size={11} />
          </button>
        </div>
      ) : (
        <button
          onClick={() => onStartEdit(manicurist.id)}
          title="Edit clock-in time"
          className="flex items-center gap-1.5 font-mono text-[11px] text-gray-500 hover:text-pink-500 border border-gray-200 hover:border-pink-200 rounded-lg px-2 py-1 transition-colors"
        >
          <Clock size={10} />
          {manicurist.clockInTime ? formatTime(manicurist.clockInTime) : 'â'}
          <Pencil size={9} className="ml-0.5 opacity-50" />
        </button>
      )}
    </div>
  );
}

// âââ Clock-in order section ââââââââââââââââââââââââââââââââââââââââââââââââââââ

interface ClockInOrderSectionProps {
  manicurists: Manicurist[];
  dispatch: React.Dispatch<import('../../state/actions').AppAction>;
}

function ClockInOrderSection({ manicurists, dispatch }: ClockInOrderSectionProps) {
  const clockedIn = useMemo(
    () =>
      manicurists
        .filter((m) => m.clockedIn)
        .sort((a, b) => (a.clockInTime ?? Infinity) - (b.clockInTime ?? Infinity)),
    [manicurists]
  );

  const [items, setItems] = useState<string[]>(() => clockedIn.map((m) => m.id));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  // Keep local order in sync when manicurists change externally (new clock-in, etc.)
  useEffect(() => {
    setItems((prev) => {
      const prevSet = new Set(prev);
      const newIds = clockedIn.map((m) => m.id);
      const newSet = new Set(newIds);
      // If same set of IDs, keep existing order; otherwise reset
      const same = newIds.every((id) => prevSet.has(id)) && prev.every((id) => newSet.has(id));
      return same ? prev : newIds;
    });
  }, [clockedIn]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = items.indexOf(active.id as string);
    const newIndex = items.indexOf(over.id as string);
    const newOrder = arrayMove(items, oldIndex, newIndex);
    setItems(newOrder);

    // Collect original clock-in times in the old sorted order, then reassign
    const originalTimes = clockedIn.map((m) => m.clockInTime);
    newOrder.forEach((id, i) => {
      dispatch({ type: 'UPDATE_MANICURIST', id, updates: { clockInTime: originalTimes[i] } });
    });
  }

  function handleStartEdit(id: string) {
    const mani = manicurists.find((m) => m.id === id);
    setEditValue(mani?.clockInTime ? timestampToTimeInput(mani.clockInTime) : '');
    setEditingId(id);
  }

  function handleSaveEdit() {
    if (!editingId) return;
    const ts = timeInputToTimestamp(editValue);
    if (ts !== null) {
      dispatch({ type: 'UPDATE_MANICURIST', id: editingId, updates: { clockInTime: ts } });
    }
    setEditingId(null);
  }

  function handleCancelEdit() {
    setEditingId(null);
  }

  if (clockedIn.length === 0) return null;

  const displayItems = items
    .map((id) => clockedIn.find((m) => m.id === id))
    .filter((m): m is Manicurist => !!m);

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 mb-6">
      <div className="flex items-center gap-2 mb-3">
        <h3 className="font-bebas text-xl tracking-[2px] text-gray-900 font-bold">CLOCK IN ORDER</h3>
        <span className="font-mono text-[9px] text-gray-400 border border-gray-200 rounded-full px-2 py-0.5 tracking-wider">
          DRAG TO REORDER Â· TAP TIME TO EDIT
        </span>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-2">
            {displayItems.map((mani) => (
              <SortableClockInRow
                key={mani.id}
                manicurist={mani}
                editingId={editingId}
                editValue={editValue}
                onStartEdit={handleStartEdit}
                onChangeEdit={setEditValue}
                onSaveEdit={handleSaveEdit}
                onCancelEdit={handleCancelEdit}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

interface HistoryTableProps {
  entries: CompletedEntry[];
  manicurists: { id: string; name: string; color: string; totalTurns: number; clockedIn: boolean; clockInTime: number | null }[];
}

function HistoryTable({ entries, manicurists }: HistoryTableProps) {
  const [sortMode, setSortMode] = useState<SortMode>('time');
  const [manicuristFilter, setManicuristFilter] = useState<string>('all');

  const manicuristNames = useMemo(() => {
    const fromEntries = entries.map((c) => c.manicuristName);
    return Array.from(new Set(fromEntries)).sort();
  }, [entries, manicurists]);

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
              </tr>
            </thead>
            <tbody>
              {sortedEntries.map((entry) => (
                <tr key={entry.id} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-gray-900">
                    {entry.clientName}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {groupServices(entry.services).map(([s, count]) => {
                        const wasRequested = Array.isArray(entry.requestedServices)
                          && entry.requestedServices.length > 0
                          && entry.requestedServices.includes(s as typeof entry.requestedServices[number]);
                        return (
                          <span key={s} className="inline-flex items-center gap-1">
                            {wasRequested && (
                              <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white font-bold text-[9px]">R</span>
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
                  <td className="px-4 py-3 font-mono text-xs font-bold text-gray-900">
                    {entry.turnValue}
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2">
                      <span
                        className="w-2.5 h-2.5 rounded-full"
                        style={{ backgroundColor: entry.manicuristColor }}
                      />
                      <span className="font-mono text-xs font-bold text-gray-900">{entry.manicuristName}</span>
                    </span>
                  </td>
                </tr>
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

  // Bar chart data â shown whenever manicurists are clocked in, even before any services complete
  const turnsPerManicurist = useMemo(() => {
    if (!viewingPastDay) {
      const clockedIn = state.manicurists
        .filter((m) => m.clockedIn)
        .sort((a, b) => (a.clockInTime ?? Infinity) - (b.clockInTime ?? Infinity));
      if (clockedIn.length > 0) {
        return clockedIn.map((m) => ({
          name: m.name,
          turns: m.totalTurns,
          color: m.color,
          clockInTime: m.clockInTime ? formatTime(m.clockInTime) : '',
        }));
      }
    }
    // Past day view or everyone clocked out: build from displayed entries
    const map = new Map<string, { name: string; turns: number; color: string; clockInTime: string }>();
    for (const e of displayedEntries) {
      if (!map.has(e.manicuristId)) {
        map.set(e.manicuristId, { name: e.manicuristName, turns: 0, color: e.manicuristColor, clockInTime: '' });
      }
      map.get(e.manicuristId)!.turns += e.turnValue;
    }
    return Array.from(map.values());
  }, [viewingPastDay, state.manicurists, displayedEntries]);

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
              {saving ? 'SAVING...' : saveError ? 'SAVE FAILED â RETRY' : 'SAVE TODAY'}
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

      {/* Clock-in order â drag to reorder, tap time to edit (today only) */}
      {!viewingPastDay && (
        <ClockInOrderSection manicurists={state.manicurists} dispatch={dispatch} />
      )}

      {turnsPerManicurist.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 p-4 mb-6">
          <h3 className="font-bebas text-xl tracking-[2px] text-gray-900 font-bold mb-3">TURNS PER MANICURIST</h3>
          <ResponsiveContainer width="100%" height={turnsPerManicurist.length * 36 + 20}>
            <BarChart data={turnsPerManicurist} layout="vertical" margin={{ top: 4, right: 30, bottom: 4, left: 0 }}>
              <YAxis
                dataKey="name"
                type="category"
                interval={0}
                tick={({ x, y, payload, index }: { x: string | number; y: string | number; payload: { value: string }; index: number }) => {
                  const entry = turnsPerManicurist[index];
                  return (
                    <g transform={`translate(${Number(x)},${Number(y)})`}>
                      <text x={-4} y={0} dy={4} textAnchor="end" fill="#111827" fontSize={11} fontFamily="IBM Plex Mono" fontWeight={700}>
                        {payload.value}
                      </text>
                      {entry?.clockInTime && (
                        <text x={-4} y={0} dy={14} textAnchor="end" fill="#9ca3af" fontSize={9} fontFamily="IBM Plex Mono">
                          {entry.clockInTime}
                        </text>
                      )}
                    </g>
                  );
                }}
                axisLine={false}
                tickLine={false}
                width={90}
              />
              <XAxis
                type="number"
                tick={{ fontSize: 10, fontFamily: 'IBM Plex Mono', fill: '#9ca3af' }}
                axisLine={false}
                tickLine={false}
                ticks={(() => {
                  const maxTurns = Math.max(...turnsPerManicurist.map((m) => m.turns), 1);
                  const maxTick = Math.ceil(maxTurns * 2) / 2;
                  const ticks = [];
                  for (let i = 0; i <= maxTick * 2; i++) ticks.push(i * 0.5);
                  return ticks;
                })()}
                domain={[0, 'dataMax']}
              />
              <Tooltip
                contentStyle={{ fontFamily: 'IBM Plex Mono', fontSize: 12, borderRadius: 12, border: '1px solid #e5e7eb' }}
              />
              <Bar
                dataKey="turns"
                radius={[0, 8, 8, 0]}
                maxBarSize={24}
                label={({ x, y, width, height, value }) => (
                  <text
                    x={Number(x) + Number(width) + 6}
                    y={Number(y) + Number(height) / 2}
                    dy={4}
                    fill="#374151"
                    fontSize={11}
                    fontFamily="IBM Plex Mono"
                    fontWeight={600}
                  >
                    {Number(value).toFixed(1)}
                  </text>
                )}
              >
                {turnsPerManicurist.map((entry, index) => (
                  <Cell key={index} fill={entry.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
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
          manicurists={state.manicurists}
        />
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
