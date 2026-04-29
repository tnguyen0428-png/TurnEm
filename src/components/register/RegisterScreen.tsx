// RegisterScreen — the SalonBiz-mirrored register tab.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Receipt, ChevronLeft, ChevronRight, Lock, Unlock, RefreshCw } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import {
  fetchTicketsForDate,
  formatMoneyCents,
  createTicketAtCheckin,
} from '../../lib/tickets';
import { fetchOpenShift } from '../../lib/shifts';
import { getTodayLA, getLocalDateStr } from '../../utils/time';
import type { Shift, Ticket } from '../../types';
import TicketModal from './TicketModal';
import OpenShiftModal from './OpenShiftModal';
import CloseShiftScreen from './CloseShiftScreen';

function formatTimeShort(ms: number): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(ms));
}

export default function RegisterScreen() {
  useApp(); // mounted so the shared state is live, but we read tickets/shifts directly

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

  const [shift, setShift] = useState<Shift | null>(null);
  const refreshShift = useCallback(async () => {
    setShift(await fetchOpenShift());
  }, []);
  useEffect(() => { void refreshShift(); }, [refreshShift]);

  const [openTicket, setOpenTicket] = useState<Ticket | null>(null);
  const [showOpenShift, setShowOpenShift] = useState(false);
  const [showCloseShift, setShowCloseShift] = useState(false);

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
            {shift ? (
              <>
                <span className="px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 font-mono text-[10px] font-bold tracking-wider border border-emerald-200">
                  SHIFT OPEN — {formatMoneyCents(shift.openingCashCents)} START
                </span>
                <button onClick={() => setShowCloseShift(true)}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-gray-700 hover:bg-white font-mono text-xs font-bold">
                  <Lock size={12} /> CLOSE SHIFT
                </button>
              </>
            ) : (
              <button onClick={() => setShowOpenShift(true)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-gray-900 text-white hover:bg-gray-800 font-mono text-xs font-bold">
                <Unlock size={12} /> OPEN SHIFT
              </button>
            )}
            <button onClick={handleNewBlank}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-gray-700 hover:bg-white font-mono text-xs font-bold">
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
          <TicketList tickets={openTickets} onClick={setOpenTicket} />
        </Section>

        <Section
          title="CLOSED TICKETS"
          count={closedTickets.length}
          totalCents={closedTickets.reduce((s, t) => s + t.paidCents, 0)}
          empty="No closed tickets yet."
          loading={loading}
        >
          <TicketList tickets={closedTickets} onClick={setOpenTicket} />
        </Section>

        {voidedTickets.length > 0 && (
          <Section
            title="VOIDED"
            count={voidedTickets.length}
            empty=""
            loading={false}
            muted
          >
            <TicketList tickets={voidedTickets} onClick={setOpenTicket} />
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
          onClose={() => setShowOpenShift(false)}
          onOpened={() => { setShowOpenShift(false); void refreshShift(); }}
        />
      )}
      {showCloseShift && shift && (
        <CloseShiftScreen
          shift={shift}
          onClose={() => setShowCloseShift(false)}
          onClosed={() => { setShowCloseShift(false); void refreshShift(); }}
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

function TicketList({ tickets, onClick }: { tickets: Ticket[]; onClick: (t: Ticket) => void }) {
  return (
    <div>
      <div className="grid grid-cols-[80px_80px_1fr_140px_120px_100px] gap-2 px-4 py-2 border-b border-gray-100 font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">
        <span>#</span>
        <span>Time</span>
        <span>Client</span>
        <span>Staff</span>
        <span>Services</span>
        <span className="text-right">Total</span>
      </div>
      {tickets.map((t) => (
        <button
          key={t.id}
          onClick={() => onClick(t)}
          className="w-full grid grid-cols-[80px_80px_1fr_140px_120px_100px] gap-2 px-4 py-3 border-b border-gray-50 last:border-b-0 hover:bg-gray-50/50 transition-colors text-left items-center"
        >
          <span className="font-mono text-sm font-bold text-gray-900">#{t.ticketNumber}</span>
          <span className="font-mono text-xs text-gray-500">{formatTimeShort(t.openedAt)}</span>
          <span className="font-mono text-sm font-semibold text-gray-900 truncate">{t.clientName}</span>
          <span className="flex items-center gap-1.5 font-mono text-xs text-gray-700">
            {t.primaryManicuristName ? (
              <>
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: t.primaryManicuristColor }} />
                <span className="truncate">{t.primaryManicuristName}</span>
              </>
            ) : (
              <span className="text-gray-300">—</span>
            )}
          </span>
          <span className="font-mono text-[10px] text-gray-500 truncate">
            {t.items.length > 0 ? t.items.map((i) => i.name).join(', ') : '—'}
          </span>
          <span className="font-mono text-sm font-bold text-gray-900 text-right flex items-center justify-end gap-1.5">
            {formatMoneyCents(t.totalCents)}
            <Receipt size={12} className="text-gray-300" />
          </span>
        </button>
      ))}
    </div>
  );
}
