import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

// Large month-grid popover used in place of the browser's tiny native
// <input type="date"> picker. Anchor it to a relatively-positioned wrapper
// around the trigger button; the popover positions itself absolutely below.

type Props = {
  /** Currently selected date as YYYY-MM-DD */
  value: string;
  /** "Today" in the salon's local tz, also YYYY-MM-DD */
  today: string;
  /** Called with the new YYYY-MM-DD when the user picks a date. */
  onChange: (date: string) => void;
  /** Called when the popover wants to close (outside click, esc, selection). */
  onClose: () => void;
  /** Optional alignment relative to the anchor; defaults to "left". */
  align?: 'left' | 'right';
};

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function parseKey(key: string): Date {
  return new Date(key + 'T00:00:00');
}

function formatKey(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getDaysInMonth(year: number, month: number): Date[] {
  const days: Date[] = [];
  const date = new Date(year, month, 1);
  while (date.getMonth() === month) {
    days.push(new Date(date));
    date.setDate(date.getDate() + 1);
  }
  return days;
}

export default function DatePickerPopover({
  value,
  today,
  onChange,
  onClose,
  align = 'left',
}: Props) {
  const initial = useMemo(() => parseKey(value || today), [value, today]);
  const [viewMonth, setViewMonth] = useState(initial.getMonth());
  const [viewYear, setViewYear] = useState(initial.getFullYear());

  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    // Defer so the same click that opens the popover doesn't immediately close it.
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', handleClick);
    }, 0);
    document.addEventListener('keydown', handleKey);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  const days = getDaysInMonth(viewYear, viewMonth);
  const firstDayOfWeek = days[0]?.getDay() ?? 0;
  const monthLabel = new Date(viewYear, viewMonth).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });

  function prevMonth() {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((y) => y - 1);
    } else {
      setViewMonth((m) => m - 1);
    }
  }
  function nextMonth() {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((y) => y + 1);
    } else {
      setViewMonth((m) => m + 1);
    }
  }

  function pick(d: Date) {
    onChange(formatKey(d));
    onClose();
  }

  function goToday() {
    const t = parseKey(today);
    setViewMonth(t.getMonth());
    setViewYear(t.getFullYear());
    onChange(today);
    onClose();
  }

  return (
    <div
      ref={containerRef}
      className={`absolute top-full mt-2 z-50 w-[360px] bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden ${
        align === 'right' ? 'right-0' : 'left-0'
      }`}
      role="dialog"
      aria-label="Pick a date"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <button
          type="button"
          onClick={prevMonth}
          className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
          aria-label="Previous month"
        >
          <ChevronLeft size={18} />
        </button>
        <h3 className="font-bebas text-lg tracking-[2px] text-gray-900">
          {monthLabel.toUpperCase()}
        </h3>
        <button
          type="button"
          onClick={nextMonth}
          className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
          aria-label="Next month"
        >
          <ChevronRight size={18} />
        </button>
      </div>

      <div className="px-3 py-3">
        <div className="grid grid-cols-7 mb-1">
          {WEEKDAYS.map((wd, i) => (
            <div key={i} className="text-center py-1">
              <span className="font-mono text-[10px] text-gray-400 font-semibold tracking-wider">
                {wd}
              </span>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: firstDayOfWeek }).map((_, i) => (
            <div key={`empty-${i}`} className="aspect-square" />
          ))}
          {days.map((day) => {
            const key = formatKey(day);
            const isSelected = key === value;
            const isToday = key === today;
            return (
              <button
                key={key}
                type="button"
                onClick={() => pick(day)}
                className={`aspect-square rounded-lg flex items-center justify-center transition-all duration-150 ${
                  isSelected
                    ? 'bg-pink-500 text-white font-bold shadow-sm'
                    : isToday
                    ? 'bg-pink-50 text-pink-600 hover:bg-pink-100 font-semibold'
                    : 'hover:bg-gray-100 text-gray-700'
                }`}
              >
                <span className="font-mono text-sm">{day.getDate()}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-between px-3 py-2 border-t border-gray-100 bg-gray-50">
        <button
          type="button"
          onClick={goToday}
          className="px-3 py-1.5 rounded-lg font-mono text-[11px] font-bold tracking-wider text-pink-600 hover:bg-pink-50 transition-colors"
        >
          TODAY
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 rounded-lg font-mono text-[11px] font-bold tracking-wider text-gray-500 hover:bg-gray-200 transition-colors"
        >
          CLOSE
        </button>
      </div>
    </div>
  );
}
