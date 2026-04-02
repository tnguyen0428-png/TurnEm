import { useState, useMemo } from 'react';
import { Clock, Trash2, User, ChevronDown, ChevronLeft, ChevronRight, Save, CalendarDays } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { useApp } from '../../state/AppContext';
import Badge from '../shared/Badge';
import EmptyState from '../shared/EmptyState';
import ConfirmDialog from '../shared/ConfirmDialog';
import { formatTime, formatDuration } from '../../utils/time';
import type { CompletedEntry } from '../../types';

function groupServices(services: string[]): [string, number][] {
  const map = new Map<string, number>();
  for (const s of services) map.set(s, (map.get(s) || 0) + 1);
  return Array.from(map.entries());
}

function getTurnBadgeVariant(value: number): 'green' | 'blue' | 'amber' {
  if (value <= 0.5) return 'green';
  if (value <= 1.0) return 'blue';
  return 'amber';
}

type SortMode = 'time' | 'client' | 'manicurist';

function getTodayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
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
  showTurnsChart: boolean;
}

function HistoryTable({ entries, manicurists, showTurnsChart }: HistoryTableProps) {
  const [sortMode, setSortMode] = useState<SortMode>('time');
  const [manicuristFilter, setManicuristFilter] = useState<string>('all');

  const manicuristNames = useMemo(() => {
    const fromEntries = entries.map((c) => c.manicuristName);
    const fromClockedIn = showTurnsChart ? manicurists.filter((m) => m.clockedIn).map((m) => m.name) : [];
    return Array.from(new Set([...fromEntries, ...fromClockedIn])).sort();
  }, [entries, manicurists, showTurnsChart]);

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

  const totalClientsServed = entries.length;
  const totalTurns = entries.reduce((sum, c) => sum + c.turnValue, 0);

  const turnsPerManicurist = useMemo(() => {
    if (showTurnsChart) {
      return manicurists
        .filter((m) => m.clockedIn)
        .map((m) => ({
          name: m.name,
          turns: m.totalTurns,
          color: m.color,
          clockInTime: m.clockInTime ? formatTime(m.clockInTime) : ''
        }))
        .sort((a, b) => {
          const aTime = a.clockInTime;
          const bTime = b.clockInTime;
          if (aTime && bTime) {
            return aTime.localeCompare(bTime);
          }
          return 0;
        });
    }
    const map = new Map<string, { name: string; turns: number; color: string; clockInTime: string }>();
    for (const e of entries) {
      if (!map.has(e.manicuristId)) {
        map.set(e.manicuristId, { name: e.manicuristName, turns: 0, color: e.manicuristColor, clockInTime: '' });
      }
      map.get(e.manicuristId)!.turns += e.turnValue;
    }
    return Array.from(map.values());
  }, [entries, manicurists, showTurnsChart]);

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-2 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-100 p-4 text-center">
          <p className="font-bebas text-3xl text-gray-900">{totalClientsServed}</p>
          <p className="font-mono text-[10px] text-gray-400 tracking-wider">CLIENTS SERVED</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4 text-center">
          <p className="font-bebas text-3xl text-gray-900">{totalTurns.toFixed(1)}</p>
          <p className="font-mono text-[10px] text-gray-400 tracking-wider">TOTAL TURNS</p>
        </div>
      </div>

      {turnsPerManicurist.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 p-4 mb-6">
          <h3 className="font-bebas text-sm tracking-[2px] text-gray-500 mb-3">TURNS PER MANICURIST</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={turnsPerManicurist} margin={{ top: 4, right: 0, bottom: 20, left: 0 }}>
              <XAxis
                dataKey="name"
                tick={({ x, y, payload }) => {
                  const entry = turnsPerManicurist.find(m => m.name === payload.value);
                  return (
                    <g transform={`translate(${x},${y})`}>
                      <text
                        x={0}
                        y={0}
                        dy={8}
                        textAnchor="middle"
                        fill="#6b7280"
                        fontSize={11}
                        fontFamily="IBM Plex Mono"
                      >
                        {payload.value}
                      </text>
                      {entry?.clockInTime && (
                        <text
                          x={0}
                          y={0}
                          dy={20}
                          textAnchor="middle"
                          fill="#9ca3af"
                          fontSize={9}
                          fontFamily="IBM Plex Mono"
                        >
                          {entry.clockInTime}
                        </text>
                      )}
                    </g>
                  );
                }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 10, fontFamily: 'IBM Plex Mono', fill: '#9ca3af' }}
                axisLine={false}
                tickLine={false}
                width={30}
                ticks={(() => {
                  const maxTurns = Math.max(...turnsPerManicurist.map(m => m.turns), 1);
                  const maxTick = Math.ceil(maxTurns * 2) / 2;
                  const ticks = [];
                  for (let i = 0; i <= maxTick * 2; i++) {
                    ticks.push(i * 0.5);
                  }
                  return ticks;
                })()}
                domain={[0, 'dataMax']}
              />
              <Tooltip
                contentStyle={{
                  fontFamily: 'IBM Plex Mono',
                  fontSize: 12,
                  borderRadius: 12,
                  border: '1px solid #e5e7eb',
                }}
              />
              <Bar dataKey="turns" radius={[8, 8, 0, 0]} maxBarSize={48}>
                {turnsPerManicurist.map((entry, index) => (
                  <Cell key={index} fill={entry.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

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
                <th className="text-left px-4 py-3 font-mono text-[10px] text-gray-400 tracking-wider font-semibold">CLIENT</th>
                <th className="text-left px-4 py-3 font-mono text-[10px] text-gray-400 tracking-wider font-semibold">SERVICE</th>
                <th className="text-left px-4 py-3 font-mono text-[10px] text-gray-400 tracking-wider font-semibold">MANICURIST</th>
                <th className="text-left px-4 py-3 font-mono text-[10px] text-gray-400 tracking-wider font-semibold">TIME</th>
                <th className="text-left px-4 py-3 font-mono text-[10px] text-gray-400 tracking-wider font-semibold">DURATION</th>
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
                      {groupServices(entry.services).map(([s, count]) => (
                        <Badge
                          key={s}
                          label={count > 1 ? `${s} x${count}` : s}
                          variant={getTurnBadgeVariant(entry.turnValue)}
                        />
                      ))}
                      <Badge
                        label={`${entry.turnValue} turns`}
                        variant={getTurnBadgeVariant(entry.turnValue)}
                      />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2">
                      <span
                        className="w-2.5 h-2.5 rounded-full"
                        style={{ backgroundColor: entry.manicuristColor }}
                      />
                      <span className="font-mono text-xs text-gray-700">{entry.manicuristName}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-[11px] text-gray-500">
                    {formatTime(entry.startedAt)} - {formatTime(entry.completedAt)}
                  </td>
                  <td className="px-4 py-3 font-mono text-[11px] text-gray-500">
                    {formatDuration(entry.startedAt, entry.completedAt)}
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
  const [showCalendar, setShowCalendar] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const today = getTodayDateStr();
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

  const displayedEntries = viewingPastDay && pastDayEntries !== null
    ? pastDayEntries
    : state.completed;

  async function handleSave() {
    setSaving(true);
    await saveTodayHistory();
    setSaving(false);
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
              className="flex items-center gap-2 px-4 py-2 rounded-xl border-2 border-emerald-200 text-emerald-600 font-mono text-xs font-semibold hover:bg-emerald-50 transition-colors disabled:opacity-50"
            >
              <Save size={14} />
              {saving ? 'SAVING...' : 'SAVE TODAY'}
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
              className="flex items-center gap-2 px-4 py-2 rounded-xl border-2 border-red-200 text-red-500 font-mono text-xs font-semibold hover:bg-red-50 transition-colors"
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
              const dateStr = day.toISOString().slice(0, 10);
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
          showTurnsChart={!viewingPastDay}
        />
      )}

      {showClearConfirm && (
        <ConfirmDialog
          message="Clear all history? This will reset today's completed services."
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
  );
}
