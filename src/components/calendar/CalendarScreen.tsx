import { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight, Lock, Unlock, Calendar, X } from 'lucide-react';
import { useApp } from '../../state/AppContext';

function getDaysInMonth(year: number, month: number): Date[] {
  const days: Date[] = [];
  const date = new Date(year, month, 1);
  while (date.getMonth() === month) {
    days.push(new Date(date));
    date.setDate(date.getDate() + 1);
  }
  return days;
}

function formatDateKey(d: Date): string {
  return d.toISOString().split('T')[0];
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function CalendarScreen() {
  const { state, dispatch } = useApp();
  const today = new Date();
  const [currentMonth, setCurrentMonth] = useState(today.getMonth());
  const [currentYear, setCurrentYear] = useState(today.getFullYear());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');

  const blockedDates = useMemo(() => {
    const map = new Map<string, { status: string; note: string }>();
    state.calendarDays.forEach((d) => map.set(d.date, { status: d.status, note: d.note }));
    return map;
  }, [state.calendarDays]);

  const days = getDaysInMonth(currentYear, currentMonth);
  const firstDayOfWeek = days[0]?.getDay() ?? 0;
  const todayKey = formatDateKey(today);

  const monthLabel = new Date(currentYear, currentMonth).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });

  function handlePrevMonth() {
    if (currentMonth === 0) {
      setCurrentMonth(11);
      setCurrentYear((y) => y - 1);
    } else {
      setCurrentMonth((m) => m - 1);
    }
  }

  function handleNextMonth() {
    if (currentMonth === 11) {
      setCurrentMonth(0);
      setCurrentYear((y) => y + 1);
    } else {
      setCurrentMonth((m) => m + 1);
    }
  }

  function handleDayClick(dateKey: string) {
    setSelectedDate(dateKey);
    const existing = blockedDates.get(dateKey);
    setNoteText(existing?.note || '');
  }

  function handleBlock() {
    if (!selectedDate) return;
    dispatch({
      type: 'SET_CALENDAR_DAY',
      day: { date: selectedDate, status: 'blocked', note: noteText.trim() },
    });
  }

  function handleOpen() {
    if (!selectedDate) return;
    dispatch({ type: 'REMOVE_CALENDAR_DAY', date: selectedDate });
    setSelectedDate(null);
    setNoteText('');
  }

  const blockedCount = state.calendarDays.filter((d) => d.status === 'blocked').length;
  const upcomingBlocked = state.calendarDays
    .filter((d) => d.status === 'blocked' && d.date >= todayKey)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 5);

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="font-bebas text-2xl tracking-[3px] text-gray-900">CALENDAR</h2>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-sm bg-emerald-100 border border-emerald-300" />
            <span className="font-mono text-[10px] text-gray-500">Open</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-sm bg-red-100 border border-red-300" />
            <span className="font-mono text-[10px] text-gray-500">Blocked</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <button
              onClick={handlePrevMonth}
              className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
            >
              <ChevronLeft size={18} />
            </button>
            <h3 className="font-bebas text-xl tracking-[2px] text-gray-900">{monthLabel.toUpperCase()}</h3>
            <button
              onClick={handleNextMonth}
              className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
            >
              <ChevronRight size={18} />
            </button>
          </div>

          <div className="px-3 py-3">
            <div className="grid grid-cols-7 mb-2">
              {WEEKDAYS.map((wd) => (
                <div key={wd} className="text-center py-2">
                  <span className="font-mono text-[10px] text-gray-400 font-semibold tracking-wider">
                    {wd.toUpperCase()}
                  </span>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-1">
              {Array.from({ length: firstDayOfWeek }).map((_, i) => (
                <div key={`empty-${i}`} className="aspect-square" />
              ))}
              {days.map((day) => {
                const dateKey = formatDateKey(day);
                const dayInfo = blockedDates.get(dateKey);
                const isBlocked = dayInfo?.status === 'blocked';
                const isToday = dateKey === todayKey;
                const isSelected = dateKey === selectedDate;
                const isPast = dateKey < todayKey;

                return (
                  <button
                    key={dateKey}
                    onClick={() => handleDayClick(dateKey)}
                    className={`aspect-square rounded-xl flex flex-col items-center justify-center transition-all duration-150 relative ${
                      isSelected
                        ? 'ring-2 ring-pink-400 ring-offset-1'
                        : ''
                    } ${
                      isBlocked
                        ? 'bg-red-50 hover:bg-red-100'
                        : isToday
                        ? 'bg-pink-50 hover:bg-pink-100'
                        : isPast
                        ? 'bg-gray-50 hover:bg-gray-100'
                        : 'hover:bg-emerald-50'
                    }`}
                  >
                    <span
                      className={`font-mono text-xs font-semibold ${
                        isBlocked
                          ? 'text-red-600'
                          : isToday
                          ? 'text-pink-600'
                          : isPast
                          ? 'text-gray-300'
                          : 'text-gray-700'
                      }`}
                    >
                      {day.getDate()}
                    </span>
                    {isBlocked && (
                      <Lock size={8} className="text-red-400 mt-0.5" />
                    )}
                    {isToday && !isBlocked && (
                      <span className="w-1 h-1 rounded-full bg-pink-500 mt-0.5" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          {selectedDate ? (
            <div className="bg-white rounded-2xl border border-gray-100 p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-bebas text-lg tracking-[2px] text-gray-900">
                  {new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-US', {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                  }).toUpperCase()}
                </h3>
                <button
                  onClick={() => { setSelectedDate(null); setNoteText(''); }}
                  className="p-1 rounded-lg hover:bg-gray-100 text-gray-400 transition-colors"
                >
                  <X size={14} />
                </button>
              </div>

              <div className={`rounded-xl p-4 mb-4 ${
                blockedDates.get(selectedDate)?.status === 'blocked'
                  ? 'bg-red-50'
                  : 'bg-emerald-50'
              }`}>
                <div className="flex items-center gap-2 mb-1">
                  {blockedDates.get(selectedDate)?.status === 'blocked' ? (
                    <>
                      <Lock size={14} className="text-red-500" />
                      <span className="font-mono text-xs font-semibold text-red-700">BLOCKED</span>
                    </>
                  ) : (
                    <>
                      <Unlock size={14} className="text-emerald-500" />
                      <span className="font-mono text-xs font-semibold text-emerald-700">OPEN</span>
                    </>
                  )}
                </div>
                <p className="font-mono text-[10px] text-gray-500">
                  {blockedDates.get(selectedDate)?.status === 'blocked'
                    ? 'No appointments or walk-ins on this day'
                    : 'Regular business hours apply'
                  }
                </p>
              </div>

              <div className="mb-4">
                <label className="block font-mono text-[10px] text-gray-400 font-semibold tracking-wider mb-1.5">
                  NOTE (OPTIONAL)
                </label>
                <input
                  type="text"
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="e.g. Holiday, Renovation..."
                  className="w-full px-3 py-2.5 rounded-xl border border-gray-200 font-mono text-xs text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
                />
              </div>

              <div className="flex gap-2">
                {blockedDates.get(selectedDate)?.status === 'blocked' ? (
                  <button
                    onClick={handleOpen}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-emerald-500 text-white font-mono text-xs font-semibold hover:bg-emerald-600 active:scale-[0.98] transition-all"
                  >
                    <Unlock size={14} />
                    OPEN DATE
                  </button>
                ) : (
                  <button
                    onClick={handleBlock}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-red-500 text-white font-mono text-xs font-semibold hover:bg-red-600 active:scale-[0.98] transition-all"
                  >
                    <Lock size={14} />
                    BLOCK DATE
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-gray-100 p-5">
              <div className="flex items-center gap-2 mb-2">
                <Calendar size={14} className="text-gray-400" />
                <h3 className="font-mono text-xs font-semibold text-gray-500 tracking-wider">SELECT A DATE</h3>
              </div>
              <p className="font-mono text-xs text-gray-400">
                Click on any date to block or open it for business
              </p>
            </div>
          )}

          <div className="bg-white rounded-2xl border border-gray-100 p-5">
            <h3 className="font-mono text-[10px] text-gray-400 font-semibold tracking-wider mb-3">
              SUMMARY
            </h3>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="rounded-xl bg-gray-50 p-3 text-center">
                <p className="font-bebas text-2xl text-gray-900">{blockedCount}</p>
                <p className="font-mono text-[9px] text-gray-400 tracking-wider">BLOCKED DAYS</p>
              </div>
              <div className="rounded-xl bg-gray-50 p-3 text-center">
                <p className="font-bebas text-2xl text-emerald-600">
                  {days.length - state.calendarDays.filter((d) => {
                    const dDate = new Date(d.date + 'T00:00:00');
                    return d.status === 'blocked' &&
                      dDate.getMonth() === currentMonth &&
                      dDate.getFullYear() === currentYear;
                  }).length}
                </p>
                <p className="font-mono text-[9px] text-gray-400 tracking-wider">OPEN THIS MONTH</p>
              </div>
            </div>

            {upcomingBlocked.length > 0 && (
              <>
                <h4 className="font-mono text-[10px] text-gray-400 font-semibold tracking-wider mb-2">
                  UPCOMING BLOCKED
                </h4>
                <div className="space-y-1.5">
                  {upcomingBlocked.map((d) => (
                    <div
                      key={d.date}
                      className="flex items-center justify-between px-3 py-2 rounded-lg bg-red-50"
                    >
                      <span className="font-mono text-[11px] text-red-700">
                        {new Date(d.date + 'T00:00:00').toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          weekday: 'short',
                        })}
                      </span>
                      {d.note && (
                        <span className="font-mono text-[10px] text-red-500 truncate ml-2">
                          {d.note}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
