import { useState, useEffect, useMemo } from 'react';
import { TrendingUp, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { getTodayLA, getLocalDateStr } from '../../utils/time';

/**
 * WeeklyTotalPanel
 * ----------------
 * Pill button shown under the Daily Schedule pill. Tap to open a full-screen
 * view of the manicurist's dollar totals for the current week and the previous
 * week (Sunday - Saturday, America/Los_Angeles).
 *
 * Data comes from the same source as the per-day amount on the Services list:
 * sum of ticket_items.ext_price_cents where staff1_id = this manicurist,
 * grouped by tickets.business_date, fetched across the past 14 days. Refreshes
 * live via realtime on tickets / ticket_items so a checkout that closed seconds
 * ago is reflected without a reload.
 *
 * Retention: daily_history rows older than 14 days are pruned nightly by the
 * pg_cron job `prune_daily_history_14d`. This panel only ever needs the past
 * 14 days of tickets, so older data is unused.
 */

interface Props {
  manicuristId: string;
}

export default function WeeklyTotalPanel({ manicuristId }: Props) {
  const [open, setOpen] = useState(false);
  const [weekAmountByDate, setWeekAmountByDate] = useState<Map<string, number>>(new Map());

  const todayStr = getTodayLA();

  // Past-14-days amount sync. Aggregates ticket_items by business_date, scoped
  // to this manicurist's staff1_id. Live via realtime so the totals tick up
  // as soon as the cashier closes a ticket.
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

  // Two-week breakdown. Week starts Sunday, ends Saturday (or today for the
  // current, in-progress week).
  const weekTotals = useMemo(() => {
    const todayDate = new Date(`${todayStr}T12:00:00`);
    const dow = todayDate.getDay(); // 0 = Sunday
    const thisWeekStart = new Date(todayDate); thisWeekStart.setDate(todayDate.getDate() - dow);
    const lastWeekEnd   = new Date(thisWeekStart); lastWeekEnd.setDate(thisWeekStart.getDate() - 1);
    const lastWeekStart = new Date(thisWeekStart); lastWeekStart.setDate(thisWeekStart.getDate() - 7);

    function sumRange(start: Date, end: Date): number {
      let cents = 0;
      const cursor = new Date(start);
      while (cursor <= end) {
        cents += weekAmountByDate.get(getLocalDateStr(cursor)) ?? 0;
        cursor.setDate(cursor.getDate() + 1);
      }
      return cents / 100;
    }
    function mmmDD(d: Date): string {
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }

    return {
      thisWeek:      sumRange(thisWeekStart, todayDate),
      lastWeek:      sumRange(lastWeekStart, lastWeekEnd),
      thisWeekRange: `${mmmDD(thisWeekStart)} - ${mmmDD(todayDate)}`,
      lastWeekRange: `${mmmDD(lastWeekStart)} - ${mmmDD(lastWeekEnd)}`,
    };
  }, [weekAmountByDate, todayStr]);

  // Esc closes the opened panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      {/* Pill button - entry point inside the staff panel layout */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full flex items-center justify-center gap-2 bg-white border border-gray-200 rounded-full px-5 py-3 active:scale-[0.98] hover:border-emerald-300 transition-all shadow-sm"
        aria-label="Open weekly total"
      >
        <TrendingUp size={16} className="text-emerald-500" />
        <span className="font-mono text-sm font-semibold text-gray-900 tracking-wide">
          Weekly Total
        </span>
      </button>

      {/* Opened full-screen view */}
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

            <div className="flex flex-col items-center gap-2 mt-2 mb-8">
              <TrendingUp size={36} className="text-emerald-500" />
              <h2 className="font-bebas text-3xl text-gray-900 tracking-wider">WEEKLY TOTAL</h2>
              <p className="font-mono text-xs text-gray-500 tracking-wide">Sunday - Saturday</p>
            </div>

            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm divide-y divide-gray-50">
              <div className="px-5 py-5 flex items-center justify-between">
                <div>
                  <p className="font-mono text-sm font-bold text-gray-900">This Week</p>
                  <p className="font-mono text-[11px] text-gray-400 mt-1">{weekTotals.thisWeekRange}</p>
                </div>
                <span className="font-bebas text-3xl text-gray-900 tabular-nums">
                  ${weekTotals.thisWeek.toFixed(0)}
                </span>
              </div>
              <div className="px-5 py-5 flex items-center justify-between">
                <div>
                  <p className="font-mono text-sm font-bold text-gray-900">Last Week</p>
                  <p className="font-mono text-[11px] text-gray-400 mt-1">{weekTotals.lastWeekRange}</p>
                </div>
                <span className="font-bebas text-3xl text-gray-900 tabular-nums">
                  ${weekTotals.lastWeek.toFixed(0)}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
