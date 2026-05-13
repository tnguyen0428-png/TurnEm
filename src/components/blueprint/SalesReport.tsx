// SalesReport — Blueprint → Reports → Sales
//
// Closed tickets only (voided / open are excluded — they show in their own
// report). Aggregates totals, payment-method breakdown, and a per-day
// breakdown table.

import { useEffect, useMemo, useState } from 'react';
import type { Ticket } from '../../types';
import { fetchTicketsForRange } from '../../lib/tickets';
import {
  ReportRangeHeader, useReportRange, formatMoney, formatLongDate, eachDateInRange,
} from './reportShared';

export default function SalesReport() {
  const [range, setRange] = useReportRange();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const all = await fetchTicketsForRange(range.from, range.to);
      if (!cancelled) {
        setTickets(all);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [range.from, range.to]);

  // Only closed tickets count toward "sales" — open tickets are still in
  // progress and voided tickets are tracked in the Cancellation report.
  const closed = useMemo(() => tickets.filter((t) => t.status === 'closed'), [tickets]);

  const summary = useMemo(() => {
    let count = 0;
    let grossCents = 0;
    let tipCents = 0;
    let taxCents = 0;
    let discountCents = 0;
    for (const t of closed) {
      count += 1;
      grossCents += t.totalCents;
      tipCents += t.tipCents;
      taxCents += t.taxCents;
      discountCents += t.discountCents;
    }
    return { count, grossCents, tipCents, taxCents, discountCents };
  }, [closed]);

  const byPaymentMethod = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of closed) {
      for (const p of t.payments) {
        const k = p.method;
        map.set(k, (map.get(k) ?? 0) + p.amountCents);
      }
    }
    return Array.from(map.entries())
      .map(([method, cents]) => ({ method, cents }))
      .sort((a, b) => b.cents - a.cents);
  }, [closed]);

  const byDay = useMemo(() => {
    const dates = eachDateInRange(range);
    const map = new Map<string, { count: number; grossCents: number; tipCents: number }>();
    for (const d of dates) map.set(d, { count: 0, grossCents: 0, tipCents: 0 });
    for (const t of closed) {
      const cur = map.get(t.businessDate);
      if (!cur) continue;
      cur.count += 1;
      cur.grossCents += t.totalCents;
      cur.tipCents += t.tipCents;
    }
    return dates.map((d) => ({ date: d, ...map.get(d)! }));
  }, [closed, range]);

  return (
    <div className="p-6 overflow-y-auto h-full space-y-5">
      <ReportRangeHeader title="SALES" range={range} onRangeChange={setRange} />

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Gross Sales" value={formatMoney(summary.grossCents)} accent="emerald" loading={loading} />
        <Kpi label="Tickets" value={summary.count.toString()} loading={loading} />
        <Kpi label="Tips" value={formatMoney(summary.tipCents)} loading={loading} />
        <Kpi label="Discounts" value={formatMoney(summary.discountCents)} loading={loading} />
      </div>

      {/* Payment method breakdown */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100">
          <h3 className="font-bebas text-lg tracking-[2px] text-gray-800">PAYMENT METHODS</h3>
        </div>
        {byPaymentMethod.length === 0 ? (
          <div className="px-4 py-6 text-center font-mono text-xs text-gray-400">
            {loading ? 'Loading…' : 'No payments captured in this range.'}
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {byPaymentMethod.map((p) => (
              <div key={p.method} className="flex items-center justify-between px-4 py-2.5">
                <span className="font-mono text-sm font-semibold text-gray-700 uppercase">
                  {p.method === 'visa_mc' ? 'Credit Card' : p.method}
                </span>
                <span className="font-mono text-sm font-bold text-gray-900">{formatMoney(p.cents)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Per-day breakdown — useful for weekly/custom views */}
      {(range.kind === 'weekly' || range.kind === 'custom') && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <h3 className="font-bebas text-lg tracking-[2px] text-gray-800">BY DAY</h3>
          </div>
          <div>
            <div className="grid grid-cols-[1fr_90px_120px_100px] gap-2 px-4 py-2 bg-gray-50 border-b border-gray-100 font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">
              <span>Date</span>
              <span className="text-right">Tickets</span>
              <span className="text-right">Gross</span>
              <span className="text-right">Tips</span>
            </div>
            {byDay.map((d) => (
              <div key={d.date} className="grid grid-cols-[1fr_90px_120px_100px] gap-2 px-4 py-2.5 border-b border-gray-50 last:border-b-0 items-center">
                <span className="font-mono text-sm text-gray-800">{formatLongDate(d.date)}</span>
                <span className="font-mono text-sm text-gray-700 text-right">{d.count}</span>
                <span className="font-mono text-sm font-semibold text-gray-900 text-right">{formatMoney(d.grossCents)}</span>
                <span className="font-mono text-sm text-gray-700 text-right">{formatMoney(d.tipCents)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi({
  label, value, accent, loading,
}: {
  label: string;
  value: string;
  accent?: 'emerald';
  loading?: boolean;
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 px-4 py-4">
      <div className="font-mono text-[10px] font-bold text-gray-400 tracking-wider uppercase">{label}</div>
      <div className={`font-mono text-2xl font-bold mt-1 ${accent === 'emerald' ? 'text-emerald-600' : 'text-gray-900'}`}>
        {loading ? '…' : value}
      </div>
    </div>
  );
}
