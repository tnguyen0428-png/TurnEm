// SalesReport — Blueprint → Reports → Sales
//
// Closed tickets only (voided / open are excluded — they show in their own
// report). Aggregates totals, payment-method breakdown, and a per-day
// breakdown table.

import { useEffect, useMemo, useState } from 'react';
import type { Shift, Ticket } from '../../types';
import { fetchTicketsForRange } from '../../lib/tickets';
import { fetchShiftsForRange } from '../../lib/shifts';
import { useApp } from '../../state/AppContext';
import {
  ReportRangeHeader, useReportRange, formatMoney, formatLongDate, formatTime, eachDateInRange,
} from './reportShared';

// Local shape for the cancellations & void detail rows — merged from voided
// tickets and cancelled/no-show appointments so a manager can see all
// negative-outcome events for the date range in one list.
interface CancelRow {
  id: string;
  date: string;
  whenMs: number;
  source: 'ticket' | 'appointment';
  status: 'voided' | 'cancelled' | 'no-show';
  clientName: string;
  reason: string;
  amountCents: number;
  byReceptionistName: string;
}

export default function SalesReport() {
  const [range, setRange] = useReportRange();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [loading, setLoading] = useState(true);
  const { state } = useApp();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      // Tickets + shifts in parallel — the Shifts section needs the drawer
      // sessions across the same date range.
      const [allTickets, allShifts] = await Promise.all([
        fetchTicketsForRange(range.from, range.to),
        fetchShiftsForRange(range.from, range.to),
      ]);
      if (!cancelled) {
        setTickets(allTickets);
        setShifts(allShifts);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [range.from, range.to]);

  // Map manicurist id → display name so the shifts table can render the
  // human name beside each opened_by / closed_by id without re-fetching.
  const manicuristNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of state.manicurists) m.set(r.id, r.name);
    return m;
  }, [state.manicurists]);

  // Only closed tickets count toward "sales" — open tickets are still in
  // progress and voided tickets are tracked in the Cancellation report.
  const closed = useMemo(() => tickets.filter((t) => t.status === 'closed'), [tickets]);

  // Per-ticket discount total = ticket-level discount + sum of line-level
  // discounts. Captures both "20% off the manicure" (line) and "loyalty
  // $5 off the whole ticket" (header).
  function ticketDiscountTotalCents(t: Ticket): number {
    let lineDiscount = 0;
    for (const it of t.items) lineDiscount += it.discountCents || 0;
    return (t.discountCents || 0) + lineDiscount;
  }

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
      discountCents += ticketDiscountTotalCents(t);
    }
    return { count, grossCents, tipCents, taxCents, discountCents };
  }, [closed]);

  const discountTickets = useMemo(() => {
    return closed
      .map((t) => ({ ...t, totalDiscountCents: ticketDiscountTotalCents(t) }))
      .filter((t) => t.totalDiscountCents > 0)
      .sort((a, b) => b.totalDiscountCents - a.totalDiscountCents);
  }, [closed]);

  // Cancellations & Void: voided tickets in range + cancelled/no-show
  // appointments in range. Same logic as the legacy CancellationReport,
  // inlined here so everything for the date range is on one page.
  const receptionistNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of state.manicurists) m.set(r.id, r.name);
    return m;
  }, [state.manicurists]);

  const cancelRows = useMemo<CancelRow[]>(() => {
    const out: CancelRow[] = [];
    for (const t of tickets) {
      if (t.status !== 'voided') continue;
      const byName = t.voidedByReceptionistId
        ? receptionistNameById.get(t.voidedByReceptionistId) ?? '(removed)'
        : '—';
      out.push({
        id: `t:${t.id}`,
        date: t.businessDate,
        whenMs: t.openedAt,
        source: 'ticket',
        status: 'voided',
        clientName: t.clientName || 'Walk-in',
        reason: t.voidReason || '',
        amountCents: t.totalCents,
        byReceptionistName: byName,
      });
    }
    for (const a of state.appointments) {
      if (a.status !== 'cancelled' && a.status !== 'no-show') continue;
      if (a.date < range.from || a.date > range.to) continue;
      const [hh, mm] = (a.time || '00:00').split(':').map((s) => parseInt(s, 10));
      const d = new Date(a.date + 'T12:00:00');
      d.setHours(Number.isFinite(hh) ? hh : 12, Number.isFinite(mm) ? mm : 0, 0, 0);
      out.push({
        id: `a:${a.id}`,
        date: a.date,
        whenMs: d.getTime(),
        source: 'appointment',
        status: a.status as 'cancelled' | 'no-show',
        clientName: a.clientName || 'Walk-in',
        reason: a.notes || '',
        amountCents: 0,
        byReceptionistName: '—',
      });
    }
    return out.sort((a, b) => b.whenMs - a.whenMs);
  }, [tickets, state.appointments, range.from, range.to, receptionistNameById]);

  const cancelSummary = useMemo(() => {
    let voided = 0;
    let cancelled = 0;
    let noShow = 0;
    let lostCents = 0;
    for (const r of cancelRows) {
      if (r.status === 'voided') { voided += 1; lostCents += r.amountCents; }
      else if (r.status === 'cancelled') cancelled += 1;
      else if (r.status === 'no-show') noShow += 1;
    }
    return { voided, cancelled, noShow, lostCents };
  }, [cancelRows]);

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

      {/* Discounts — every ticket where money was taken off (line or ticket-level) */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3">
          <h3 className="font-bebas text-lg tracking-[2px] text-gray-800">DISCOUNTS</h3>
          <span className="font-mono text-[10px] text-gray-400">
            {discountTickets.length} ticket{discountTickets.length === 1 ? '' : 's'} · {formatMoney(summary.discountCents)} total
          </span>
        </div>
        {discountTickets.length === 0 ? (
          <div className="px-4 py-6 text-center font-mono text-xs text-gray-400">
            {loading ? 'Loading…' : 'No discounts applied in this range.'}
          </div>
        ) : (
          <div>
            <div className="grid grid-cols-[80px_110px_1fr_1fr_110px_110px] gap-2 px-4 py-2 bg-gray-50 border-b border-gray-100 font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">
              <span>Ticket</span>
              <span>Date</span>
              <span>Client</span>
              <span>Primary Staff</span>
              <span className="text-right">Discount</span>
              <span className="text-right">Net Total</span>
            </div>
            {discountTickets.map((t) => (
              <div key={t.id} className="grid grid-cols-[80px_110px_1fr_1fr_110px_110px] gap-2 px-4 py-2.5 border-b border-gray-50 last:border-b-0 items-center">
                <span className="font-mono text-sm font-bold text-gray-800">#{t.ticketNumber}</span>
                <span className="font-mono text-xs text-gray-700">{formatLongDate(t.businessDate)}</span>
                <span className="font-mono text-sm font-semibold text-gray-900 truncate">{t.clientName || 'Walk-in'}</span>
                <span className="font-mono text-sm text-gray-700 truncate">{t.primaryManicuristName || '—'}</span>
                <span className="font-mono text-sm text-red-600 text-right">-{formatMoney(t.totalDiscountCents)}</span>
                <span className="font-mono text-sm font-bold text-gray-900 text-right">{formatMoney(t.totalCents)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cancellations & Void — voided tickets + cancelled / no-show appts */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3">
          <h3 className="font-bebas text-lg tracking-[2px] text-gray-800">CANCELLATIONS &amp; VOID</h3>
          <span className="font-mono text-[10px] text-gray-400">
            {cancelSummary.voided} voided · {cancelSummary.cancelled} cancelled · {cancelSummary.noShow} no-show · {formatMoney(cancelSummary.lostCents)} lost
          </span>
        </div>
        {cancelRows.length === 0 ? (
          <div className="px-4 py-6 text-center font-mono text-xs text-gray-400">
            {loading ? 'Loading…' : 'No cancellations in this range.'}
          </div>
        ) : (
          <div>
            <div className="grid grid-cols-[120px_70px_90px_1fr_120px_1fr_90px] gap-2 px-4 py-2 bg-gray-50 border-b border-gray-100 font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">
              <span>Date</span>
              <span>Time</span>
              <span>Status</span>
              <span>Client</span>
              <span>Voided by</span>
              <span>Reason</span>
              <span className="text-right">Amount</span>
            </div>
            {cancelRows.map((r) => (
              <div key={r.id} className="grid grid-cols-[120px_70px_90px_1fr_120px_1fr_90px] gap-2 px-4 py-2.5 border-b border-gray-50 last:border-b-0 items-center">
                <span className="font-mono text-xs text-gray-700">{formatLongDate(r.date)}</span>
                <span className="font-mono text-xs text-gray-500">{formatTime(r.whenMs)}</span>
                <span>
                  <CancelStatusPill status={r.status} />
                </span>
                <span className="font-mono text-sm font-semibold text-gray-900 truncate">{r.clientName}</span>
                <span
                  className="font-mono text-xs text-gray-700 truncate"
                  title={r.byReceptionistName}
                >
                  {r.byReceptionistName}
                </span>
                <span className="font-mono text-xs text-gray-500 truncate">{r.reason || '—'}</span>
                <span className="font-mono text-sm text-gray-900 text-right">
                  {r.amountCents > 0 ? formatMoney(r.amountCents) : '—'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Shifts — who opened/closed each drawer session in this range */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100">
          <h3 className="font-bebas text-lg tracking-[2px] text-gray-800">SHIFTS</h3>
        </div>
        {shifts.length === 0 ? (
          <div className="px-4 py-6 text-center font-mono text-xs text-gray-400">
            {loading ? 'Loading…' : 'No shifts opened in this range.'}
          </div>
        ) : (
          <div>
            <div className="grid grid-cols-[110px_120px_1fr_120px_1fr_90px_100px] gap-2 px-4 py-2 bg-gray-50 border-b border-gray-100 font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">
              <span>Date</span>
              <span>Opened</span>
              <span>Opened by</span>
              <span>Closed</span>
              <span>Closed by</span>
              <span className="text-right">Variance</span>
              <span className="text-right">Status</span>
            </div>
            {shifts.map((s) => {
              const openedName = s.openedByReceptionistId
                ? manicuristNameById.get(s.openedByReceptionistId) ?? '(removed)'
                : '—';
              const closedName = s.closedByReceptionistId
                ? manicuristNameById.get(s.closedByReceptionistId) ?? '(removed)'
                : '—';
              const variance = s.varianceCents ?? null;
              return (
                <div
                  key={s.id}
                  className="grid grid-cols-[110px_120px_1fr_120px_1fr_90px_100px] gap-2 px-4 py-2.5 border-b border-gray-50 last:border-b-0 items-center"
                >
                  <span className="font-mono text-sm text-gray-800">{formatLongDate(s.businessDate)}</span>
                  <span className="font-mono text-sm text-gray-700">
                    {new Date(s.openedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </span>
                  <span className="font-mono text-sm text-gray-800 truncate" title={openedName}>{openedName}</span>
                  <span className="font-mono text-sm text-gray-700">
                    {s.closedAt
                      ? new Date(s.closedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
                      : '—'}
                  </span>
                  <span className="font-mono text-sm text-gray-800 truncate" title={closedName}>{closedName}</span>
                  <span
                    className={`font-mono text-sm text-right ${
                      variance === null
                        ? 'text-gray-400'
                        : variance === 0
                          ? 'text-gray-700'
                          : variance > 0
                            ? 'text-emerald-600'
                            : 'text-red-600'
                    }`}
                  >
                    {variance === null ? '—' : formatMoney(variance)}
                  </span>
                  <span
                    className={`font-mono text-[10px] font-bold tracking-wider text-right uppercase ${
                      s.status === 'open' ? 'text-emerald-600' : 'text-gray-500'
                    }`}
                  >
                    {s.status}
                  </span>
                </div>
              );
            })}
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

function CancelStatusPill({ status }: { status: 'voided' | 'cancelled' | 'no-show' }) {
  const cls =
    status === 'voided'
      ? 'bg-amber-50 text-amber-700'
      : 'bg-red-50 text-red-700';
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full font-mono text-[10px] font-bold tracking-wider uppercase ${cls}`}>
      {status}
    </span>
  );
}
