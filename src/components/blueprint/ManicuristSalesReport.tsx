// ManicuristSalesReport — Blueprint → Reports → Staff → Manicurists
//
// Per-manicurist productivity for the selected range. Closed tickets only.
// "Sales credited" uses each line's staff1 — that's how each manicurist
// sale is tracked elsewhere in the app.
//
// Click a manicurist's name to expand an inline detail panel listing every
// service line they were credited for: date, ticket #, client, service,
// and price.

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Printer } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import type { Ticket, TicketItem } from '../../types';
import { fetchTicketsForRange, computeLineExt } from '../../lib/tickets';
import {
  ReportRangeHeader, useReportRange, formatMoney, formatLongDate, rangeLabel,
} from './reportShared';
import { printManicuristReport } from './printManicuristReport';

interface StaffRow {
  staffId: string;
  staffName: string;
  serviceCount: number;
  grossCents: number;
}

interface ServiceLine {
  ticketId: string;
  ticketNumber: number;
  businessDate: string;
  clientName: string;
  serviceName: string;
  extCents: number;
}

function lineExt(it: TicketItem | { unitPriceCents: number; quantity: number; discountCents: number }) {
  return computeLineExt({
    unitPriceCents: it.unitPriceCents,
    quantity: it.quantity,
    discountCents: it.discountCents,
  });
}

interface DayGroup {
  businessDate: string;
  lines: ServiceLine[];
  subtotalCents: number;
}

// Lines are pre-sorted newest-first by date then ticket # — group
// consecutive same-date lines into day sections with a subtotal each.
function groupByDay(lines: ServiceLine[]): DayGroup[] {
  const days: DayGroup[] = [];
  for (const line of lines) {
    const last = days[days.length - 1];
    if (!last || last.businessDate !== line.businessDate) {
      days.push({ businessDate: line.businessDate, lines: [line], subtotalCents: line.extCents });
    } else {
      last.lines.push(line);
      last.subtotalCents += line.extCents;
    }
  }
  return days;
}

export default function ManicuristSalesReport() {
  const { state } = useApp();
  const [range, setRange] = useReportRange();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

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

  // Build per-manicurist aggregates AND a flat list of every credited line
  // so the click-to-expand detail panel can render without re-walking the
  // ticket list. Receptionists are excluded.
  const { rows, linesByStaff } = useMemo(() => {
    const receptionistIds = new Set(
      state.manicurists.filter((m) => m.isReceptionist).map((m) => m.id),
    );
    const rowMap = new Map<string, StaffRow>();
    const linesMap = new Map<string, ServiceLine[]>();

    function keyFor(id: string | null, name: string): string {
      return id ?? `__no_id__:${name}`;
    }

    for (const t of closed) {
      for (const it of t.items) {
        if (it.kind !== 'service') continue;
        if (it.staff1Id && receptionistIds.has(it.staff1Id)) continue;
        const ext = lineExt(it);
        const k = keyFor(it.staff1Id, it.staff1Name);
        let row = rowMap.get(k);
        if (!row) {
          row = {
            staffId: it.staff1Id ?? '',
            staffName: it.staff1Name || '(Unassigned)',
            serviceCount: 0,
            grossCents: 0,
          };
          rowMap.set(k, row);
        }
        row.serviceCount += 1;
        row.grossCents += ext;

        let lines = linesMap.get(k);
        if (!lines) { lines = []; linesMap.set(k, lines); }
        lines.push({
          ticketId: t.id,
          ticketNumber: t.ticketNumber,
          businessDate: t.businessDate,
          clientName: t.clientName || 'Walk-in',
          serviceName: it.name,
          extCents: ext,
        });
      }
    }

    // Sort each manicurist's detail lines newest-first by date then ticket #.
    for (const list of linesMap.values()) {
      list.sort((a, b) => {
        if (a.businessDate !== b.businessDate) return b.businessDate.localeCompare(a.businessDate);
        return b.ticketNumber - a.ticketNumber;
      });
    }

    const sortedRows = Array.from(rowMap.values()).sort((a, b) => b.grossCents - a.grossCents);
    return { rows: sortedRows, linesByStaff: linesMap };
  }, [closed, state.manicurists]);

  const summary = useMemo(() => {
    const totalGross = rows.reduce((s, r) => s + r.grossCents, 0);
    const totalServices = rows.reduce((s, r) => s + r.serviceCount, 0);
    return { totalGross, totalServices, manicurists: rows.length };
  }, [rows]);

  function rowKey(r: StaffRow): string {
    return r.staffId || `__no_id__:${r.staffName}`;
  }

  return (
    <div className="p-6 overflow-y-auto h-full space-y-5">
      <ReportRangeHeader title="MANICURISTS" range={range} onRangeChange={setRange} />

      <div className="grid grid-cols-3 gap-3">
        <Kpi label="Manicurists" value={summary.manicurists.toString()} loading={loading} />
        <Kpi label="Services" value={summary.totalServices.toString()} accent="red" loading={loading} />
        <Kpi label="Total Sales" value={formatMoney(summary.totalGross)} accent="emerald" loading={loading} />
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3">
          <h3 className="font-bebas text-lg tracking-[2px] text-gray-800">PER MANICURIST</h3>
          <span className="font-mono text-[10px] text-gray-400">Click a name to see every service performed</span>
        </div>
        {rows.length === 0 ? (
          <div className="px-4 py-10 text-center font-mono text-xs text-gray-400">
            {loading ? 'Loading…' : 'No manicurist activity in this range.'}
          </div>
        ) : (
          <div>
            <div className="grid grid-cols-[1fr_120px_140px_36px] gap-2 px-4 py-2 bg-gray-50 border-b border-gray-100 font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">
              <span>Manicurist</span>
              <span className="text-right">Services</span>
              <span className="text-right">Sales</span>
              <span></span>
            </div>
            {rows.map((r, idx) => {
              const k = rowKey(r);
              const expanded = expandedKey === k;
              const lines = linesByStaff.get(k) ?? [];
              const zebra = idx % 2 === 1;
              const dayGroups = groupByDay(lines);
              return (
                <div key={k} className="border-b border-gray-50 last:border-b-0">
                  <div
                    // The row itself had no background reaction at all: only the
                    // name button inside it lit up (hover:text-pink-700), so the
                    // line you are actually reading across never highlighted.
                    className={`w-full grid grid-cols-[1fr_120px_140px_36px] gap-2 px-4 py-2.5 items-center transition-colors hover:bg-pink-50 active:bg-pink-100 ${
                      zebra ? 'bg-gray-50' : 'bg-white'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setExpandedKey(expanded ? null : k)}
                      className="font-mono text-sm font-semibold text-gray-900 truncate flex items-center gap-1.5 text-left hover:text-pink-700"
                    >
                      {expanded
                        ? <ChevronDown size={14} className="text-gray-400" />
                        : <ChevronRight size={14} className="text-gray-400" />}
                      {r.staffName}
                    </button>
                    <span className="font-mono text-sm text-gray-700 text-right">{r.serviceCount}</span>
                    {/* Same size as the day total below it, so the per-staff
                        figure and the per-day figures read as one scale. */}
                    <span className="font-mono text-lg font-bold text-gray-900 text-right">
                      {formatMoney(r.grossCents)}
                    </span>
                    <button
                      type="button"
                      onClick={() => printManicuristReport({
                        staffName: r.staffName,
                        rangeLabel: rangeLabel(range),
                        lines,
                        totalServices: r.serviceCount,
                        totalCents: r.grossCents,
                      })}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-pink-700 hover:bg-pink-100 transition-colors justify-self-end"
                      title={`Print ${r.staffName}'s report`}
                    >
                      <Printer size={14} />
                    </button>
                  </div>
                  {expanded && (
                    <div className="bg-gray-50/60 px-4 pt-2 pb-3 space-y-3">
                      {dayGroups.length === 0 ? (
                        <p className="font-mono text-xs text-gray-400 py-3 text-center">
                          No service lines.
                        </p>
                      ) : (
                        dayGroups.map((day) => (
                          <div key={day.businessDate} className="rounded-lg bg-white border border-gray-100 overflow-hidden">
                            <div className="grid grid-cols-[70px_1fr_1fr_110px] gap-2 px-3 py-1.5 bg-gray-50 border-b border-gray-100 font-mono text-[10px] tracking-wider font-semibold text-gray-500 uppercase">
                              <span className="col-span-3">{formatLongDate(day.businessDate)}</span>
                              <span className="text-right">Price</span>
                            </div>
                            {day.lines.map((line, idx) => (
                              <div
                                key={`${line.ticketId}:${idx}`}
                                className={`grid grid-cols-[70px_1fr_1fr_110px] gap-2 px-3 py-2 border-b border-gray-50 items-center transition-colors hover:bg-pink-100 active:bg-pink-100 ${
                                  idx % 2 === 1 ? 'bg-gray-50' : ''
                                }`}
                              >
                                <span className="font-mono text-xs font-bold text-gray-800">#{line.ticketNumber}</span>
                                <span className="font-mono text-xs text-gray-800 truncate">{line.clientName}</span>
                                <span className="font-mono text-xs text-gray-700 truncate">{line.serviceName}</span>
                                <span className="font-mono text-xs font-semibold text-gray-900 text-right">
                                  {formatMoney(line.extCents)}
                                </span>
                              </div>
                            ))}
                            {/* The day total is the number this report exists to
                                answer, so it is set apart from the line rows:
                                pink and noticeably larger rather than the same
                                12px gray as every price above it. */}
                            <div className="flex items-center justify-between px-3 py-2 bg-pink-50 border-t border-pink-100">
                              <span className="font-mono text-[11px] tracking-wider font-semibold text-pink-600 uppercase">
                                Day total ({day.lines.length})
                              </span>
                              <span className="font-mono text-lg font-bold text-pink-600">
                                {formatMoney(day.subtotalCents)}
                              </span>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({
  label, value, accent, loading,
}: {
  label: string; value: string; accent?: 'emerald' | 'red'; loading?: boolean;
}) {
  const color = accent === 'emerald'
    ? 'text-emerald-600'
    : accent === 'red'
      ? 'text-red-600'
      : 'text-gray-900';
  return (
    <div className="bg-white rounded-2xl border border-gray-100 px-4 py-4">
      <div className="font-mono text-[10px] font-bold text-gray-400 tracking-wider uppercase">{label}</div>
      <div className={`font-mono text-2xl font-bold mt-1 ${color}`}>
        {loading ? '…' : value}
      </div>
    </div>
  );
}
