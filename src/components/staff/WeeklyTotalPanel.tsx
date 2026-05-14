import { useState, useEffect, useMemo } from 'react';
import { TrendingUp, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { getTodayLA, getLocalDateStr } from '../../utils/time';

/**
 * WeeklyTotalPanel
 * ----------------
 * Pill button shown under the Daily Schedule pill. Tap to open a full-screen
 * view that breaks the manicurist's dollar totals down day-by-day for the
 * current and previous Sunday-Saturday weeks.
 *
 * Data: sum of ticket_items.ext_price_cents where staff1_id = this manicurist,
 * grouped by tickets.business_date, fetched across the past 14 days. Refreshes
 * live via realtime on tickets / ticket_items.
 *
 * Retention: daily_history rows older than 14 days are pruned nightly by the
 * pg_cron job `prune_daily_history_14d`.
 */

interface Props {
  manicuristId: string;
}

interface DayRow {
  dateStr: string;        // YYYY-MM-DD
  dayName: string;        // "Sun", "Mon", ...
  mdy: string;            // 05/14/2026
  dollars: number;
  isToday: boolean;
  isFuture: boolean;
}

export default function WeeklyTotalPanel({ manicuristId }: Props) {
  const [open, setOpen] = useState(false);
  const [weekAmountByDate, setWeekAmountByDate] = useState<Map<string, number>>(new Map());

  const todayStr = getTodayLA();

  useEffect(() => {
    let cancelled = false;

    function fourteenDaysAgoStr(): string {
      const d = new Date(`${todayStr}T12:00:00`);
      d.setDate(d.getDate() - 13);
      return getLocalDateStr(d);
    }

    async function refresh() {
      try {
        const startStr = fourteenDaysAgoStr();
        const { data: ticketRows, error: tErr } = await supabase
          .from('tickets')
          .select('id, business_date')
          .gte('business_date', startStr)
          .lte('business_date', todayStr);
        if (cancelled) return;
        if (tErr) { console.error('[weekly total] tickets fetch:', tErr.message); return; }
        const dateByTicketId = new Map<string, string>();
        for (const t of (ticketRows ?? []) as Array<{ id: string; business_date: string }>) {
          dateByTicketId.set(t.id, t.business_date);
        }
        const ticketIds = Array.from(dateByTicketId.keys());
        if (ticketIds.length === 0) {
          if (!cancelled) setWeekAmountByDate(new Map());
          return;
        }
        const { data: itemRows, error: iErr } = await supabase
          .from('ticket_items')
          .select('ticket_id, staff1_id, ext_price_cents')
          .in('ticket_id', ticketIds);
        if (cancelled) return;
        if (iErr) { console.error('[weekly total] items fetch:', iErr.message); return; }
        const sumByDate = new Map<string, number>();
        for (const i of (itemRows ?? []) as Array<{ ticket_id: string; staff1_id: string | null; ext_price_cents: number }>) {
          if (i.staff1_id !== manicuristId) continue;
          const date = dateByTicketId.get(i.ticket_id);
          if (!date) continue;
          sumByDate.set(date, (sumByDate.get(date) ?? 0) + (i.ext_price_cents ?? 0));
        }
        if (!cancelled) setWeekAmountByDate(sumByDate);
      } catch (e) {
        if (!cancelled) console.error('[weekly total] refresh error:', e);
      }
    }

    void refresh();

    const channel = supabase
      .channel('weekly-total-amounts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets' },      () => { void refresh(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ticket_items' }, () => { void refresh(); })
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [todayStr, manicuristId]);

  // Day-by-day breakdown for the current week (Sun-Sat) and the previous week.
  const breakdown = useMemo(() => {
    const todayDate = new Date(`${todayStr}T12:00:00`);
    const dow = todayDate.getDay(); // 0 = Sunday
    const thisWeekStart = new Date(todayDate); thisWeekStart.setDate(todayDate.getDate() - dow);
    const lastWeekStart = new Date(thisWeekStart); lastWeekStart.setDate(thisWeekStart.getDate() - 7);

    function buildDays(start: Date): DayRow[] {
      const rows: DayRow[] = [];
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      for (let i = 0; i < 7; i++) {
        const cursor = new Date(start);
        cursor.setDate(start.getDate() + i);
        const ds = getLocalDateStr(cursor);
        const cents = weekAmountByDate.get(ds) ?? 0;
        rows.push({
          dateStr: ds,
          dayName: dayNames[cursor.getDay()],
          mdy: cursor.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }),
          dollars: cents / 100,
          isToday: ds === todayStr,
          isFuture: ds > todayStr,
        });
      }
      return rows;
    }

    const thisWeekDays = buildDays(thisWeekStart);
    const lastWeekDays = buildDays(lastWeekStart);
    const thisWeekTotal = thisWeekDays.reduce((s, d) => s + d.dollars, 0);
    const lastWeekTotal = lastWeekDays.reduce((s, d) => s + d.dollars, 0);

    function mmmDD(d: Date): string {
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    const thisWeekRange = `${mmmDD(thisWeekStart)} - ${mmmDD(new Date(thisWeekStart.getTime() + 6 * 86400000))}`;
    const lastWeekRange = `${mmmDD(lastWeekStart)} - ${mmmDD(new Date(lastWeekStart.getTime() + 6 * 86400000))}`;

    return { thisWeekDays, lastWeekDays, thisWeekTotal, lastWeekTotal, thisWeekRange, lastWeekRange };
  }, [weekAmountByDate, todayStr]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  function renderWeek(title: string, range: string, days: DayRow[], total: number) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between bg-gray-50">
          <div>
            <p className="font-mono text-sm font-bold text-gray-900">{title}</p>
            <p className="font-mono text-[11px] text-gray-400 mt-0.5">{range}</p>
          </div>
          <span className="font-bebas text-2xl text-pink-600 tabular-nums tracking-wider">
            ${total.toFixed(0)}
          </span>
        </div>
        <div className="divide-y divide-gray-50">
          {days.map((d) => (
            <div
              key={d.dateStr}
              className={`px-4 py-2.5 flex items-center justify-between ${d.isToday ? 'bg-pink-50/60' : ''} ${d.isFuture ? 'opacity-40' : ''}`}
            >
              <div className="flex items-center gap-2">
                <span className={`font-mono text-sm font-semibold w-10 ${d.isToday ? 'text-pink-700' : 'text-gray-700'}`}>
                  {d.dayName}
                </span>
                <span className="font-mono text-[11px] text-gray-400">{d.mdy}</span>
                {d.isToday && (
                  <span className="px-1.5 py-0.5 rounded bg-pink-100 text-pink-700 font-mono text-[9px] font-bold tracking-wider">
                    TODAY
                  </span>
                )}
              </div>
              <span className={`font-mono text-sm tabular-nums ${d.dollars > 0 ? 'font-bold text-gray-900' : 'text-gray-300'}`}>
                ${d.dollars.toFixed(0)}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full flex items-center justify-center gap-2 bg-white border border-gray-200 rounded-full px-5 py-3 active:scale-[0.98] hover:border-emerald-300 transition-all shadow-sm"
        aria-label="Open weekly total"
      >
        <TrendingUp size={16} className="text-emerald-500" />
        <span className="font-mono text-sm font-semibold text-gray-900 tracking-wide">
          Weekly Total · Tổng tuần
        </span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 bg-white overflow-y-auto"
          role="dialog"
          aria-modal="true"
          aria-label="Weekly total"
        >
          <div className="min-h-screen max-w-lg mx-auto px-4 pt-5 pb-10">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="p-2 -mr-2 rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                aria-label="Close weekly total"
              >
                <X size={22} />
              </button>
            </div>

            <div className="flex flex-col items-center gap-2 mt-2 mb-6">
              <TrendingUp size={36} className="text-emerald-500" />
              <h2 className="font-bebas text-3xl text-gray-900 tracking-wider">WEEKLY TOTAL</h2>
              <p className="font-mono text-xs text-gray-500 tracking-wide">Sunday - Saturday</p>
            </div>

            <div className="space-y-4">
              {renderWeek('This Week', breakdown.thisWeekRange, breakdown.thisWeekDays, breakdown.thisWeekTotal)}
              {renderWeek('Last Week', breakdown.lastWeekRange, breakdown.lastWeekDays, breakdown.lastWeekTotal)}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
