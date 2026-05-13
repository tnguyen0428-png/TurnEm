// ManicuristSalesReport — Blueprint → Reports → Staff → Manicurists
//
// Per-manicurist productivity for the selected range. Pulls from closed
// tickets (services performed + revenue credited), tips (allocated by
// share of staff1 lines on the ticket), and the local clockLog.
//
// "Sales credited" uses each line's staff1 — that's how each manicurist /
// front-desk sale is tracked elsewhere in the app. Tips on a ticket are
// split proportionally to each line's extended price the staff worked on.

import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../state/AppContext';
import type { Ticket, TicketItem } from '../../types';
import { fetchTicketsForRange, computeLineExt } from '../../lib/tickets';
import { getAllEvents, sessionsFromEvents } from '../../lib/clockLog';
import {
  ReportRangeHeader, useReportRange, formatMoney,
} from './reportShared';

interface StaffRow {
  staffId: string;
  staffName: string;
  serviceCount: number;       // # ticket lines credited to this staff
  ticketsCount: number;       // distinct closed tickets they appeared on
  grossCents: number;         // sum of extended price of their lines
  tipCents: number;           // allocated share of ticket tips
  totalCents: number;         // gross + tips
  hoursMs: number | null;     // sum of completed clock sessions; null if no log
  openSessions: number;       // count of still-open clock sessions in range
}

function lineExt(it: TicketItem | { unitPriceCents: number; quantity: number; discountCents: number }) {
  return computeLineExt({
    unitPriceCents: it.unitPriceCents,
    quantity: it.quantity,
    discountCents: it.discountCents,
  });
}

export default function ManicuristSalesReport() {
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

  // Closed tickets only — open/voided aren't completed work.
  const closed = useMemo(() => tickets.filter((t) => t.status === 'closed'), [tickets]);

  // Build per-employee aggregates.
  const rows = useMemo<StaffRow[]>(() => {
    // Build a set of receptionist staff ids so we can exclude their lines
    // from the manicurist productivity table. Receptionists get their own
    // hours-focused view in the sibling Receptionist sub-tab.
    const receptionistIds = new Set(
      state.manicurists.filter((m) => m.isReceptionist).map((m) => m.id),
    );
    const map = new Map<string, StaffRow>();
    function get(id: string | null, name: string): StaffRow {
      const key = id ?? `__no_id__:${name}`;
      let r = map.get(key);
      if (!r) {
        r = {
          staffId: id ?? '',
          staffName: name || '(Unassigned)',
          serviceCount: 0,
          ticketsCount: 0,
          grossCents: 0,
          tipCents: 0,
          totalCents: 0,
          hoursMs: 0,
          openSessions: 0,
        };
        map.set(key, r);
      }
      return r;
    }

    for (const t of closed) {
      // Track unique staff on this ticket so we count one "ticket appeared on" per.
      const ticketStaffSeen = new Set<string>();
      // Compute total extended for tip allocation.
      const totalExt = t.items.reduce((s, it) => s + lineExt(it), 0);
      for (const it of t.items) {
        // Skip receptionist staff — they don't perform manicure services
        // and their lines (e.g. retail) belong in a different report later.
        if (it.staff1Id && receptionistIds.has(it.staff1Id)) continue;
        const ext = lineExt(it);
        const row = get(it.staff1Id, it.staff1Name);
        row.serviceCount += 1;
        row.grossCents += ext;
        const key = it.staff1Id ?? `__no_id__:${it.staff1Name}`;
        if (!ticketStaffSeen.has(key)) {
          row.ticketsCount += 1;
          ticketStaffSeen.add(key);
        }
        // Tip allocation: proportional to line ext.
        if (t.tipCents > 0 && totalExt > 0) {
          row.tipCents += Math.round((ext / totalExt) * t.tipCents);
        }
      }
    }

    // Sum hours from clock log within the range.
    const fromMs = new Date(range.from + 'T00:00:00').getTime();
    const toMs = new Date(range.to + 'T23:59:59.999').getTime();
    const events = getAllEvents().filter((e) => e.timestamp >= fromMs && e.timestamp <= toMs);
    const sessions = sessionsFromEvents(events);
    for (const s of sessions) {
      const m = state.manicurists.find((mm) => mm.id === s.staffId);
      if (m?.isReceptionist) continue; // receptionists handled in sibling tab
      const row = get(s.staffId, m?.name || s.staffName);
      if (s.durationMs != null) row.hoursMs = (row.hoursMs ?? 0) + s.durationMs;
      else row.openSessions += 1;
    }

    // Finalize totals
    for (const r of map.values()) {
      r.totalCents = r.grossCents + r.tipCents;
    }

    return Array.from(map.values()).sort((a, b) => b.totalCents - a.totalCents);
  }, [closed, range.from, range.to, state.manicurists]);

  const summary = useMemo(() => {
    const totalGross = rows.reduce((s, r) => s + r.grossCents, 0);
    const totalTips = rows.reduce((s, r) => s + r.tipCents, 0);
    const totalHoursMs = rows.reduce((s, r) => s + (r.hoursMs ?? 0), 0);
    return { totalGross, totalTips, totalHoursMs, manicurists: rows.length };
  }, [rows]);

  return (
    <div className="p-6 overflow-y-auto h-full space-y-5">
      <ReportRangeHeader title="MANICURISTS" range={range} onRangeChange={setRange} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Manicurists Active" value={summary.manicurists.toString()} loading={loading} />
        <Kpi label="Total Sales" value={formatMoney(summary.totalGross)} accent="emerald" loading={loading} />
        <Kpi label="Total Tips" value={formatMoney(summary.totalTips)} loading={loading} />
        <Kpi label="Hours Logged" value={formatHours(summary.totalHoursMs)} loading={loading} />
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3">
          <h3 className="font-bebas text-lg tracking-[2px] text-gray-800">PER MANICURIST</h3>
          <span className="font-mono text-[10px] text-gray-400">Ranked by total credited</span>
        </div>
        {rows.length === 0 ? (
          <div className="px-4 py-10 text-center font-mono text-xs text-gray-400">
            {loading ? 'Loading…' : 'No manicurist activity in this range.'}
          </div>
        ) : (
          <div>
            <div className="grid grid-cols-[1fr_80px_80px_120px_100px_100px_120px] gap-2 px-4 py-2 bg-gray-50 border-b border-gray-100 font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">
              <span>Manicurist</span>
              <span className="text-right">Tickets</span>
              <span className="text-right">Services</span>
              <span className="text-right">Sales</span>
              <span className="text-right">Tips</span>
              <span className="text-right">Hours</span>
              <span className="text-right">Total</span>
            </div>
            {rows.map((r) => (
              <div
                key={r.staffId || r.staffName}
                className="grid grid-cols-[1fr_80px_80px_120px_100px_100px_120px] gap-2 px-4 py-2.5 border-b border-gray-50 last:border-b-0 items-center"
              >
                <span className="font-mono text-sm font-semibold text-gray-900 truncate">
                  {r.staffName}
                  {r.openSessions > 0 && (
                    <span className="ml-2 font-mono text-[9px] text-amber-600">{r.openSessions} open</span>
                  )}
                </span>
                <span className="font-mono text-sm text-gray-700 text-right">{r.ticketsCount}</span>
                <span className="font-mono text-sm text-gray-700 text-right">{r.serviceCount}</span>
                <span className="font-mono text-sm text-gray-900 text-right">{formatMoney(r.grossCents)}</span>
                <span className="font-mono text-sm text-gray-700 text-right">{formatMoney(r.tipCents)}</span>
                <span className="font-mono text-sm text-gray-700 text-right">
                  {r.hoursMs && r.hoursMs > 0 ? formatHours(r.hoursMs) : '—'}
                </span>
                <span className="font-mono text-sm font-bold text-gray-900 text-right">{formatMoney(r.totalCents)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatHours(ms: number): string {
  if (!ms || ms <= 0) return '0h';
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function Kpi({
  label, value, accent, loading,
}: {
  label: string; value: string; accent?: 'emerald'; loading?: boolean;
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
