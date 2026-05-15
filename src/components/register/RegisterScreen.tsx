// RegisterScreen — the SalonBiz-mirrored register tab.
// (Closed-shift viewing wired in.)

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Receipt, ChevronLeft, ChevronRight, Lock, Unlock, RefreshCw, Sun, Moon, ArrowUp, ArrowDown } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import {
  fetchTicketsForDate,
  formatMoneyCents,
  createTicketAtCheckin,
  reconcileMissingTicketsForDate,
  mergeOpenTicketsByClient,
} from '../../lib/tickets';
import { fetchShiftsForDate } from '../../lib/shifts';
import { getTodayLA, getLocalDateStr } from '../../utils/time';
import type { Shift, Ticket } from '../../types';
import TicketModal from './TicketModal';
import OpenShiftModal from './OpenShiftModal';
import CloseShiftScreen from './CloseShiftScreen';
import ReceptionistClockModal from './ReceptionistClockModal';

// Sort dimensions applied across all three ticket lists.
type SortKey = 'time' | 'total' | 'number' | 'client' | 'staff';
type SortDir = 'asc' | 'desc';

function formatTimeShort(ms: number): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(ms));
}

export default function RegisterScreen() {
  const { state, dispatch } = useApp();

  const [dateLA, setDateLA] = useState<string>(getTodayLA());
  const isToday = dateLA === getTodayLA();

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    const rows = await fetchTicketsForDate(dateLA, 'all');
    setTickets(rows);
    setLoading(false);
  }, [dateLA]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const completedForDate = state.completed.filter(
      (c) => getLocalDateStr(new Date(c.completedAt)) === dateLA,
    );
    if (completedForDate.length === 0) return;

    let cancelled = false;
    (async () => {
      try {
        const { created, appendedTo } = await reconcileMissingTicketsForDate(
          dateLA,
          completedForDate,
          state.salonServices,
        );
        if (cancelled) return;
        const merged = await mergeOpenTicketsByClient(dateLA);
        if (cancelled) return;
        const changed = created > 0 || appendedTo > 0 || merged > 0;
        if (changed) {
          console.info(
            `[register] reconciled — created ${created}, appended ${appendedTo}, ` +
            `merged ${merged} pre-existing split ticket(s)`,
          );
          const rows = await fetchTicketsForDate(dateLA, 'all');
          if (!cancelled) setTickets(rows);
        }
      } catch (err) {
        if (!cancelled) console.warn('[register] reconcile failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [dateLA, state.completed, state.salonServices]);

  const [shifts, setShifts] = useState<Shift[]>([]);
  const refreshShift = useCallback(async () => {
    setShifts(await fetchShiftsForDate(dateLA));
  }, [dateLA]);
  useEffect(() => { void refreshShift(); }, [refreshShift]);
  const shift = useMemo(() => shifts.find((s) => s.status === 'open') ?? null, [shifts]);
  const closedShifts = useMemo(
    () => shifts.filter((s) => s.status === 'closed')
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)),
    [shifts],
  );

  const [openTicket, setOpenTicket] = useState<Ticket | null>(null);
  const [showOpenShift, setShowOpenShift] = useState(false);
  const [showCloseShift, setShowCloseShift] = useState(false);
  const [viewShift, setViewShift] = useState<Shift | null>(null);
  const [showClockModal, setShowClockModal] = useState(false);

  const [sortKey, setSortKey] = useState<SortKey>('time');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  function handleSortChange(k: SortKey) {
    if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(k);
      setSortDir(k === 'time' || k === 'total' || k === 'number' ? 'desc' : 'asc');
    }
  }

  const receptionists = useMemo(
    () => state.manicurists.filter((m) => m.isReceptionist),
    [state.manicurists],
  );
  const openTickets = useMemo(() => tickets.filter((t) => t.status === 'open'), [tickets]);
  const closedTickets = useMemo(() => tickets.filter((t) => t.status === 'closed'), [tickets]);
  const voidedTickets = useMemo(() => tickets.filter((t) => t.status === 'voided'), [tickets]);

  async function handleNewBlank() {
    const created = await createTicketAtCheckin({
      queueEntryId: null,
      appointmentId: null,
      clientName: 'Walk-in',
      primaryManicuristId: null,
      primaryManicuristName: '',
      primaryManicuristColor: '#9ca3af',
      items: [],
    });
    if (created) {
      await refresh();
      setOpenTicket(created);
    }
  }

  function shiftDate(days: number) {
    const d = new Date(dateLA + 'T12:00:00');
    d.setDate(d.getDate() + days);
    const next = getLocalDateStr(d);
    if (next <= getTodayLA()) setDateLA(next);
  }

  return (
    <div className="h-full overflow-y-auto bg-[#fafafa]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-bebas text-3xl tracking-widest text-gray-900">REGISTER</h1>
          <div className="flex items-center gap-1 ml-2">
            <button onClick={() => shiftDate(-1)}
              className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-white">
              <ChevronLeft size={14} />
            </button>
            <span className="font-mono text-xs font-semibold px-3 py-1.5 border border-gray-200 rounded-lg bg-white">
              {isToday ? 'TODAY' : dateLA}
            </span>
            <button onClick={() => shiftDate(1)}
              disabled={isToday}
              className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-white disabled:opacity-30">
              <ChevronRight size={14} />
            </button>
          </div>
          <button onClick={() => void refresh()}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-white font-mono text-[10px] font-semibold tracking-wider"
            title="Refresh">
            <RefreshCw size={12} />
          </button>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setShowClockModal(true)}
              title="Clock in / Clock out"
              className="relative flex items-center justify-center h-12 w-12 rounded-lg border border-gray-200 bg-gradient-to-br from-amber-50 to-indigo-50 hover:from-amber-100 hover:to-indigo-100 text-gray-700"
            >
              <Sun size={20} className="text-amber-500 -mr-1.5" />
              <Moon size={18} className="text-indigo-500" />
            </button>
            {closedShifts.map((cs) => (
              <button
                key={cs.id}
                onClick={() => setViewShift(cs)}
                title={cs.closedAt ? `Closed ${new Date(cs.closedAt).toLocaleString()} — click to view` : 'Click to view'}
                className="h-12 px-4 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 hover:text-gray-800 font-mono text-sm font-bold tracking-wider border border-gray-200 transition-colors flex items-center"
              >
                SHIFT CLOSED
              </button>
            ))}
            {shift ? (
              <>
                <span className="h-12 px-4 rounded-lg bg-emerald-50 text-emerald-700 font-mono text-sm font-bold tracking-wider border border-emerald-200 flex items-center">
                  SHIFT OPEN
                </span>
                <button onClick={() => setShowCloseShift(true)}
                  className="h-12 px-4 flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 text-red-600 hover:bg-red-100 hover:border-red-400 font-mono text-sm font-bold transition-colors">
                  <Lock size={16} /> CLOSE SHIFT
                </button>
              </>
            ) : (
              <button onClick={() => setShowOpenShift(true)}
                className="h-12 px-4 flex items-center gap-2 rounded-lg bg-gray-900 text-white hover:bg-gray-800 font-mono text-sm font-bold">
                <Unlock size={16} /> OPEN SHIFT
              </button>
            )}
            <button onClick={handleNewBlank}
              className="h-12 px-4 flex items-center gap-2 rounded-lg border border-yellow-400 bg-yellow-50 text-yellow-700 hover:bg-yellow-100 hover:border-yellow-500 font-mono text-sm font-bold transition-colors">
              + NEW TICKET
            </button>
          </div>
        </div>

        <Section
          title="OPEN TICKETS"
          count={openTickets.length}
          empty="No open tickets."
          loading={loading}
        >
          <TicketList tickets={openTickets} onClick={setOpenTicket} sortKey={sortKey} sortDir={sortDir} onSortChange={handleSortChange} />
        </Section>

        <Section
          title="CLOSED TICKETS"
          count={closedTickets.length}
          empty="No closed tickets yet."
          loading={loading}
        >
          <TicketList tickets={closedTickets} onClick={setOpenTicket} sortKey={sortKey} sortDir={sortDir} onSortChange={handleSortChange} />
        </Section>

        {voidedTickets.length > 0 && (
          <Section
            title="VOIDED"
            count={voidedTickets.length}
            empty=""
            loading={false}
            muted
          >
            <TicketList tickets={voidedTickets} onClick={setOpenTicket} sortKey={sortKey} sortDir={sortDir} onSortChange={handleSortChange} />
          </Section>
        )}
      </div>

      {openTicket && (
        <TicketModal
          ticket={openTicket}
          onClose={() => { setOpenTicket(null); void refresh(); void refreshShift(); }}
          onChanged={(saved) => setOpenTicket(saved)}
        />
      )}
      {showOpenShift && (
        <OpenShiftModal
          receptionists={receptionists}
          onClose={() => setShowOpenShift(false)}
          onOpened={() => { setShowOpenShift(false); void refreshShift(); }}
        />
      )}
      {showCloseShift && shift && (
        <CloseShiftScreen
          shift={shift}
          receptionists={receptionists}
          onClose={() => setShowCloseShift(false)}
          onClosed={() => { setShowCloseShift(false); void refreshShift(); }}
        />
      )}
      {viewShift && (
        <CloseShiftScreen
          shift={viewShift}
          receptionists={receptionists}
          onClose={() => setViewShift(null)}
          onClosed={() => setViewShift(null)}
        />
      )}
      {showClockModal && (
        <ReceptionistClockModal
          receptionists={state.manicurists.filter((m) => m.isReceptionist)}
          onClose={() => setShowClockModal(false)}
          onClockIn={(id) => dispatch({ type: 'CLOCK_IN', id })}
          onClockOut={(id) => dispatch({ type: 'CLOCK_OUT', id })}
        />
      )}
    </div>
  );
}

function Section({
  title, count, totalCents, empty, loading, muted, children,
}: {
  title: string;
  count: number;
  totalCents?: number;
  empty: string;
  loading: boolean;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`bg-white rounded-xl border border-gray-100 overflow-hidden ${muted ? 'opacity-70' : ''}`}>
      <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3">
        <h2 className="font-bebas text-xl tracking-widest text-gray-900">{title}</h2>
        <span className="font-mono text-[10px] text-gray-400">{count}</span>
        {totalCents !== undefined && count > 0 && (
          <span className="ml-auto font-mono text-xs font-bold text-gray-700">
            {formatMoneyCents(totalCents)}
          </span>
        )}
      </div>
      <div>
        {loading ? (
          <div className="px-4 py-8 text-center font-mono text-xs text-gray-400">Loading…</div>
        ) : count === 0 ? (
          empty ? (
            <div className="px-4 py-8 text-center font-mono text-xs text-gray-400">{empty}</div>
          ) : null
        ) : (
          children
        )}
      </div>
    </div>
  );
}

function TicketList({
  tickets, onClick, sortKey, sortDir, onSortChange,
}: {
  tickets: Ticket[];
  onClick: (t: Ticket) => void;
  sortKey: SortKey;
  sortDir: SortDir;
  onSortChange: (k: SortKey) => void;
}) {
  const sorted = useMemo(() => {
    const dirMul = sortDir === 'asc' ? 1 : -1;
    return [...tickets].sort((a, b) => {
      switch (sortKey) {
        case 'number': return (a.ticketNumber - b.ticketNumber) * dirMul;
        case 'total':  return (a.totalCents - b.totalCents) * dirMul;
        case 'client': return a.clientName.localeCompare(b.clientName) * dirMul;
        case 'staff':  return (a.primaryManicuristName ?? '').localeCompare(b.primaryManicuristName ?? '') * dirMul;
        case 'time':
        default:       return (a.openedAt - b.openedAt) * dirMul;
      }
    });
  }, [tickets, sortKey, sortDir]);

  return (
    <div>
      <div className="grid grid-cols-[60px_80px_180px_minmax(160px,1.2fr)_minmax(220px,2fr)_110px] gap-3 px-4 py-2 border-b border-gray-100 font-mono text-base tracking-wider font-normal text-gray-400 uppercase">
        <SortHdr label="#"      keyId="number" sortKey={sortKey} sortDir={sortDir} onClick={onSortChange} />
        <SortHdr label="Time"   keyId="time"   sortKey={sortKey} sortDir={sortDir} onClick={onSortChange} />
        <SortHdr label="Client" keyId="client" sortKey={sortKey} sortDir={sortDir} onClick={onSortChange} />
        <SortHdr label="Staff"  keyId="staff"  sortKey={sortKey} sortDir={sortDir} onClick={onSortChange} />
        <span>Services</span>
        <SortHdr label="Total"  keyId="total"  sortKey={sortKey} sortDir={sortDir} onClick={onSortChange} align="right" />
      </div>
      {sorted.map((t) => (
        <button
          key={t.id}
          onClick={() => onClick(t)}
          className="w-full grid grid-cols-[60px_80px_180px_minmax(160px,1.2fr)_minmax(220px,2fr)_110px] gap-3 px-4 py-3 border-b border-gray-50 last:border-b-0 hover:bg-gray-50/50 transition-colors text-left items-center"
        >
          <span className="font-mono text-base font-bold text-gray-900">#{t.ticketNumber}</span>
          <span className="font-mono text-base text-gray-700">{formatTimeShort(t.openedAt)}</span>
          <span className="font-mono text-base font-semibold text-gray-900 truncate">{t.clientName}</span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-base text-gray-700 min-w-0">
            {(() => {
              const seen = new Set<string>();
              const list: { id: string; name: string; color: string }[] = [];
              for (const it of t.items) {
                if (it.kind !== 'service') continue;
                const key = (it.staff1Id ?? '') + '|' + (it.staff1Name ?? '');
                if (seen.has(key) || !it.staff1Name) continue;
                seen.add(key);
                list.push({ id: it.staff1Id ?? '', name: it.staff1Name, color: it.staff1Color });
              }
              if (list.length === 0 && t.primaryManicuristName) {
                list.push({ id: t.primaryManicuristId ?? '', name: t.primaryManicuristName, color: t.primaryManicuristColor });
              }
              if (list.length === 0) return <span className="text-gray-300">—</span>;
              return list.map((s, i) => (
                <span key={s.id || s.name + i} className="inline-flex items-center gap-1 min-w-0">
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
                  <span className="truncate">{s.name}</span>
                </span>
              ));
            })()}
          </span>
          <span className="font-mono text-base text-gray-700 flex items-start gap-2 min-w-0">
            {t.items.length > 0 ? (
              <>
                <span className="flex-shrink-0 w-7 h-7 rounded-full border-2 border-red-500 text-red-600 font-mono text-base font-bold flex items-center justify-center">
                  {t.items.filter((i) => i.kind === 'service').length}
                </span>
                <span className="text-gray-700 leading-snug break-words self-center">{t.items.map((i) => i.name).join(', ')}</span>
              </>
            ) : (
              <span>—</span>
            )}
          </span>
          <span className="font-mono text-base font-bold text-gray-900 text-right flex items-center justify-end gap-1.5">
            {formatMoneyCents(t.totalCents)}
            <Receipt size={12} className="text-gray-300" />
          </span>
        </button>
      ))}
    </div>
  );
}

function SortHdr({
  label, keyId, sortKey, sortDir, onClick, align = 'left',
}: {
  label: string;
  keyId: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onClick: (k: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const active = sortKey === keyId;
  return (
    <button
      onClick={() => onClick(keyId)}
      className={`flex items-center gap-1 font-mono text-base tracking-wider font-normal uppercase hover:text-gray-700 transition-colors ${
        align === 'right' ? 'justify-end' : ''
      } ${active ? 'text-gray-700' : 'text-gray-400'}`}
    >
      <span>{label}</span>
      {active && (sortDir === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />)}
    </button>
  );
}
