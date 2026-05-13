// reportShared.tsx — date-range picker and helpers shared by Sales,
// Cancellation, and Employee reports in the Blueprint Reports tab.
//
// Range options:
//   - DAILY : pick a single business date (defaults to today)
//   - WEEKLY: pick a Mon–Sun week (defaults to the current week)
//   - CUSTOM: pick from/to dates
//
// All ranges produce an LA-local YYYY-MM-DD `from` and `to` pair so callers
// can feed them straight into fetchTicketsForRange / appointment filters.

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getTodayLA, getLocalDateStr } from '../../utils/time';

export type RangeKind = 'daily' | 'weekly' | 'custom';

export interface RangeValue {
  kind: RangeKind;
  from: string;       // YYYY-MM-DD inclusive
  to: string;         // YYYY-MM-DD inclusive
  /** Single anchor date — used by daily/weekly nav arrows. */
  anchor: string;     // YYYY-MM-DD
  /** Custom-only — separate from `from`/`to` so anchor remains stable. */
  customFrom: string;
  customTo: string;
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return getLocalDateStr(d);
}
function startOfWeekIso(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  const dow = d.getDay(); // 0 = Sun. Use Mon as week start.
  const offset = (dow + 6) % 7;
  d.setDate(d.getDate() - offset);
  return getLocalDateStr(d);
}
function endOfWeekIso(iso: string): string {
  const start = startOfWeekIso(iso);
  return addDays(start, 6);
}

export function defaultRange(): RangeValue {
  const today = getTodayLA();
  return {
    kind: 'daily',
    from: today,
    to: today,
    anchor: today,
    customFrom: today,
    customTo: today,
  };
}

export function setKind(prev: RangeValue, kind: RangeKind): RangeValue {
  if (kind === 'daily') {
    return { ...prev, kind, from: prev.anchor, to: prev.anchor };
  }
  if (kind === 'weekly') {
    const ws = startOfWeekIso(prev.anchor);
    const we = endOfWeekIso(prev.anchor);
    return { ...prev, kind, from: ws, to: we };
  }
  // custom
  return { ...prev, kind, from: prev.customFrom, to: prev.customTo };
}

export function shiftRange(prev: RangeValue, dir: -1 | 1): RangeValue {
  if (prev.kind === 'daily') {
    const next = addDays(prev.anchor, dir);
    return { ...prev, anchor: next, from: next, to: next };
  }
  if (prev.kind === 'weekly') {
    const nextAnchor = addDays(prev.anchor, dir * 7);
    const ws = startOfWeekIso(nextAnchor);
    const we = endOfWeekIso(nextAnchor);
    return { ...prev, anchor: nextAnchor, from: ws, to: we };
  }
  // custom — nothing to shift sensibly
  return prev;
}

export function setCustomFrom(prev: RangeValue, from: string): RangeValue {
  // Keep from <= to.
  const to = prev.customTo && from > prev.customTo ? from : prev.customTo;
  return { ...prev, customFrom: from, customTo: to, from, to };
}
export function setCustomTo(prev: RangeValue, to: string): RangeValue {
  const from = prev.customFrom && to < prev.customFrom ? to : prev.customFrom;
  return { ...prev, customFrom: from, customTo: to, from, to };
}

export function rangeLabel(r: RangeValue): string {
  if (r.kind === 'daily') {
    return r.from === getTodayLA() ? 'TODAY' : formatLongDate(r.from);
  }
  if (r.kind === 'weekly') {
    return `${formatShortDate(r.from)} – ${formatShortDate(r.to)}`;
  }
  return `${formatShortDate(r.from)} – ${formatShortDate(r.to)}`;
}

export function formatLongDate(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  }).format(d);
}
export function formatShortDate(iso: string): string {
  const d = new Date(iso + 'T12:00:00');
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric',
  }).format(d);
}
export function formatTime(ms: number): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(ms));
}
export function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const r = abs % 100;
  return `${sign}$${dollars.toLocaleString()}.${r.toString().padStart(2, '0')}`;
}

/**
 * Iterate all LA-local dates from r.from to r.to inclusive.
 */
export function eachDateInRange(r: RangeValue): string[] {
  const out: string[] = [];
  let cur = r.from;
  while (cur <= r.to) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

// ── UI: header date-range picker shared by every report ────────────────────

export function ReportRangeHeader({
  title,
  range,
  onRangeChange,
}: {
  title: string;
  range: RangeValue;
  onRangeChange: (r: RangeValue) => void;
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-4 flex flex-wrap items-end gap-4">
      <div>
        <h2 className="font-bebas text-2xl tracking-[2px] text-gray-900">{title}</h2>
        <p className="font-mono text-[10px] text-gray-400 mt-0.5">{rangeLabel(range)}</p>
      </div>

      <div className="flex items-end gap-2">
        <div>
          <label className="block font-mono text-[10px] font-bold text-gray-400 tracking-wider mb-1">RANGE</label>
          <div className="flex gap-1">
            {(['daily', 'weekly', 'custom'] as RangeKind[]).map((k) => (
              <button
                key={k}
                onClick={() => onRangeChange(setKind(range, k))}
                className={`px-3 py-2 rounded-lg font-mono text-[11px] font-semibold tracking-wider transition-colors ${
                  range.kind === k ? 'bg-gray-900 text-white' : 'border border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                {k === 'daily' ? 'DAILY' : k === 'weekly' ? 'WEEKLY' : 'CUSTOM'}
              </button>
            ))}
          </div>
        </div>

        {range.kind !== 'custom' && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => onRangeChange(shiftRange(range, -1))}
              className="p-2 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50"
              title="Previous"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              onClick={() => onRangeChange(shiftRange(range, 1))}
              className="p-2 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50"
              title="Next"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        )}

        {range.kind === 'custom' && (
          <>
            <div>
              <label className="block font-mono text-[10px] font-bold text-gray-400 tracking-wider mb-1">FROM</label>
              <input
                type="date" value={range.customFrom}
                onChange={(e) => onRangeChange(setCustomFrom(range, e.target.value))}
                className="px-3 py-2 rounded-lg border border-gray-200 font-mono text-sm focus:outline-none focus:border-gray-400"
              />
            </div>
            <div>
              <label className="block font-mono text-[10px] font-bold text-gray-400 tracking-wider mb-1">TO</label>
              <input
                type="date" value={range.customTo}
                onChange={(e) => onRangeChange(setCustomTo(range, e.target.value))}
                className="px-3 py-2 rounded-lg border border-gray-200 font-mono text-sm focus:outline-none focus:border-gray-400"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * useReportRange — convenience hook for owning RangeValue state in a report
 * component. Returns [range, setRange] tuple.
 */
export function useReportRange(): [RangeValue, (r: RangeValue) => void] {
  const [range, setRange] = useState<RangeValue>(() => defaultRange());
  // Memoize the tuple so consumers can pass it down without rerendering.
  return useMemo<[RangeValue, (r: RangeValue) => void]>(() => [range, setRange], [range]);
}
