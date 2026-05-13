// CancellationReport — Blueprint → Reports → Cancellation
//
// Pulls two sources:
//   - Voided tickets in range (with reason + total lost)
//   - Appointments in range with status cancelled or no-show
// Aggregates and shows a unified list so management can spot patterns.

import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../state/AppContext';
import type { Ticket } from '../../types';
import { fetchTicketsForRange } from '../../lib/tickets';
import {
  ReportRangeHeader, useReportRange, formatMoney, formatLongDate, formatTime,
} from './reportShared';

interface Row {
  id: string;
  date: string;             // YYYY-MM-DD
  whenMs: number;           // sortable time
  source: 'ticket' | 'appointment';
  status: string;           // 'voided' | 'cancelled' | 'no-show'
  clientName: string;
  reason: string;
  amountCents: number;      // total lost (tickets only — 0 for appointments)
  byReceptionistName: string; // who voided/cancelled it, or '—' if unknown
}

export default function CancellationReport() {
  const { state } = useApp();
  const [range, setRange] = useReportRange();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const all = await fetchTicketsForRange(range.from, range.to);
      if (!cancelled) { setTickets(all); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [range.from, range.to]);

  // Receptionist id → display name lookup for the "Voided by" column.
  const receptionistNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of state.manicurists) m.set(r.id, r.name);
    return m;
  }, [state.manicurists]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];

    // Voided tickets
    for (const t of tickets) {
      if (t.status !== 'voided') continue;
      const byId = t.voidedByReceptionistId;
      const byName = byId
        ? receptionistNameById.get(byId) ?? '(removed)'
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

    // Cancelled / no-show appointments in date range
    for (const a of state.appointments) {
      if (a.status !== 'cancelled' && a.status !== 'no-show') continue;
      if (a.date < range.from || a.date > range.to) continue;
      // Build a sortable time using date + time string ("HH:MM") if available.
      const [hh, mm] = (a.time || '00:00').split(':').map((s) => parseInt(s, 10));
      const d = new Date(a.date + 'T12:00:00');
      d.setHours(Number.isFinite(hh) ? hh : 12, Number.isFinite(mm) ? mm : 0, 0, 0);
      out.push({
        id: `a:${a.id}`,
        date: a.date,
        whenMs: d.getTime(),
        source: 'appointment',
        status: a.status,
        clientName: a.clientName || 'Walk-in',
        reason: a.notes || '',
        amountCents: 0,
        byReceptionistName: '—',
      });
    }

    return out.sort((a, b) => b.whenMs - a.whenMs);
  }, [tickets, state.appointments, range.from, range.to, receptionistNameById]);

  const summary = useMemo(() => {
    let voided = 0;
    let cancelled = 0;
    let noShow = 0;
    let lostRevenueCents = 0;
    for (const r of rows) {
      if (r.status === 'voided') { voided += 1; lostRevenueCents += r.amountCents; }
      else if (r.status === 'cancelled') cancelled += 1;
      else if (r.status === 'no-show') noShow += 1;
    }
    return { voided, cancelled, noShow, lostRevenueCents };
  }, [rows]);

  return (
    <div className="p-6 overflow-y-auto h-full space-y-5">
      <ReportRangeHeader title="CANCELLATIONS & VOID" range={range} onRangeChange={setRange} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Voided Tickets" value={summary.voided.toString()} accent="amber" loading={loading} />
        <Kpi label="Cancelled Appts" value={summary.cancelled.toString()} accent="red" loading={loading} />
        <Kpi label="No-shows" value={summary.noShow.toString()} accent="red" loading={loading} />
        <Kpi label="Revenue Lost" value={formatMoney(summary.lostRevenueCents)} accent="red" loading={loading} />
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3">
          <h3 className="font-bebas text-lg tracking-[2px] text-gray-800">DETAILS</h3>
          <span className="font-mono text-[10px] text-gray-400">{rows.length} entries</span>
        </div>
        {rows.length === 0 ? (
          <div className="px-4 py-10 text-center font-mono text-xs text-gray-400">
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
            {rows.map((r) => (
              <div key={r.id} className="grid grid-cols-[120px_70px_90px_1fr_120px_1fr_90px] gap-2 px-4 py-2.5 border-b border-gray-50 last:border-b-0 items-center">
                <span className="font-mono text-xs text-gray-700">{formatLongDate(r.date)}</span>
                <span className="font-mono text-xs text-gray-500">{formatTime(r.whenMs)}</span>
                <span>
                  <StatusPill status={r.status} />
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
    </div>
  );
}

function Kpi({
  label, value, accent, loading,
}: {
  label: string; value: string; accent?: 'amber' | 'red'; loading?: boolean;
}) {
  const c = accent === 'amber' ? 'text-amber-600' : accent === 'red' ? 'text-red-600' : 'text-gray-900';
  return (
    <div className="bg-white rounded-2xl border border-gray-100 px-4 py-4">
      <div className="font-mono text-[10px] font-bold text-gray-400 tracking-wider uppercase">{label}</div>
      <div className={`font-mono text-2xl font-bold mt-1 ${c}`}>{loading ? '…' : value}</div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    voided:     'bg-amber-50 text-amber-700',
    cancelled:  'bg-red-50 text-red-700',
    'no-show':  'bg-red-50 text-red-700',
  };
  const cls = map[status] || 'bg-gray-50 text-gray-700';
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full font-mono text-[10px] font-bold tracking-wider uppercase ${cls}`}>
      {status}
    </span>
  );
}
