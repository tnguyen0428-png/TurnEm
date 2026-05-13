// CloseShiftScreen — SalonBiz-mirrored Close Shift surface.
//
// Five tabs:
//   - Payments Summary    : per-tender row with starting / # pays / total /
//                           change out / drawer ± / you have / errors
//   - Reconcile Cash      : count the drawer by denomination, variance + note
//   - Cash Transactions   : every cash payment for this shift
//   - Payment Transactions: every payment, filterable by method
//   - Ticket List         : every ticket closed against this shift
//
// Open-ticket guard:
//   On mount we look for any tickets with status='open' on the shift's
//   business date. If any are open the close button is disabled and the
//   user sees a banner: "Please close ticket before closing day."
//   Once the open count hits zero the prompt flips to "Ready to close."

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, X } from 'lucide-react';
import {
  closeShift,
  computeShiftBalance,
  type ShiftBalanceLine,
} from '../../lib/shifts';
import {
  formatMoneyCents,
  fetchTicketsForDate,
  fetchTicketsForShift,
} from '../../lib/tickets';
import type { Manicurist, Payment, PaymentMethod, Shift, Ticket } from '../../types';
import MoneyCountTable, {
  totalFromCount,
  type DenominationCount,
} from './MoneyCountTable';

interface Props {
  shift: Shift;
  /** Roster of receptionists who can PIN-gate the close. */
  receptionists: Manicurist[];
  onClose: () => void;
  onClosed: () => void;
}

type Tab = 'summary' | 'reconcile' | 'cash' | 'card' | 'gift' | 'tickets';

export default function CloseShiftScreen({ shift, receptionists, onClose, onClosed }: Props) {
  const [tab, setTab] = useState<Tab>('summary');
  const [lines, setLines] = useState<ShiftBalanceLine[]>([]);
  const [expectedCashCents, setExpectedCashCents] = useState(0);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [openTickets, setOpenTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [balance, shiftTickets, dateTickets] = await Promise.all([
      computeShiftBalance(shift.id),
      fetchTicketsForShift(shift.id),
      fetchTicketsForDate(shift.businessDate, 'all'),
    ]);
    if (balance) {
      setLines(balance.lines);
      setExpectedCashCents(balance.expectedCashCents);
    }
    setTickets(shiftTickets);
    setOpenTickets(dateTickets.filter((t) => t.status === 'open'));
    setLoading(false);
  }, [shift.id, shift.businessDate]);

  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  // ─── Closing denomination count ───────────────────────────────────────────
  const [closingCount, setClosingCount] = useState<DenominationCount>({});
  const declaredCents = totalFromCount(closingCount);
  const varianceCents = declaredCents - expectedCashCents;
  const [varianceNote, setVarianceNote] = useState('');

  // ─── Close-shift action ───────────────────────────────────────────────────
  const [busy, setBusy] = useState(false);
  const [receptionistId, setReceptionistId] = useState<string>('');
  const [pin, setPin] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const hasOpenTickets = openTickets.length > 0;

  async function handleCloseShift() {
    setError(null);
    if (hasOpenTickets) {
      setError('Please close all open tickets before closing the shift.');
      return;
    }
    if (varianceCents !== 0 && !varianceNote.trim()) {
      setError('Variance is non-zero — please add a note explaining why.');
      return;
    }
    const selected = receptionists.find((r) => r.id === receptionistId) ?? null;
    if (!selected) {
      setError('Pick a receptionist to attribute the close to.');
      return;
    }
    if (!selected.pinCode) {
      setError(`${selected.name} has no PIN configured. Set one in Staff before closing.`);
      return;
    }
    if (pin !== selected.pinCode) {
      setError('Incorrect PIN.');
      return;
    }
    setBusy(true);
    const closed = await closeShift({
      shiftId: shift.id,
      declaredCashCents: declaredCents,
      expectedCashCents,
      varianceNote: varianceNote.trim(),
      closingCount,
      receptionistId: selected.id,
    });
    setBusy(false);
    if (!closed) {
      setError('Could not close shift — try again.');
      return;
    }
    onClosed();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // All payments across this shift's closed tickets — used by Cash &
  // Payment Transactions tabs.
  const allPayments = useMemo<EnrichedPayment[]>(() => {
    const out: EnrichedPayment[] = [];
    for (const t of tickets) {
      // Use the primary staff for "Staff" column; if multiple service lines
      // exist with different staff, fall back to the first item's staff.
      const staffName =
        t.primaryManicuristName ||
        t.items.find((it) => it.staff1Name)?.staff1Name ||
        '';
      for (const p of t.payments) {
        out.push({
          ...p,
          ticketNumber: t.ticketNumber,
          ticketId: t.id,
          clientName: t.clientName || 'Walk-in',
          staffName,
        });
      }
    }
    return out;
  }, [tickets]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[95vh] flex flex-col animate-modal-in">
        <div className="px-6 py-3 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="font-bebas text-2xl tracking-widest text-gray-900">CLOSE SHIFT</h2>
            <p className="font-mono text-xs text-gray-400 mt-0.5">
              Drawer #{shift.drawerNumber} — opened {new Date(shift.openedAt).toLocaleString()}
              {shift.openedByReceptionistId ? (
                <>
                  {' '}by{' '}
                  <span className="font-bold text-gray-600">
                    {receptionists.find((r) => r.id === shift.openedByReceptionistId)?.name
                      ?? 'unknown'}
                  </span>
                </>
              ) : null}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setRefreshKey((k) => k + 1)}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 font-mono text-[10px] font-semibold tracking-wider">
              <RefreshCw size={11} /> REFRESH
            </button>
            <button onClick={onClose}
              className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Open-ticket banner / ready banner */}
        {!loading && (
          hasOpenTickets ? (
            <OpenTicketsBanner tickets={openTickets} />
          ) : (
            <ReadyBanner />
          )
        )}

        <div className="px-6 pt-2 border-b border-gray-100 flex items-center gap-1 flex-wrap">
          <TabBtn active={tab === 'summary'}   onClick={() => setTab('summary')}>PAYMENTS SUMMARY</TabBtn>
          <TabBtn active={tab === 'reconcile'} onClick={() => setTab('reconcile')}>RECONCILE CASH</TabBtn>
          <TabBtn active={tab === 'cash'}      onClick={() => setTab('cash')}>CASH TRANSACTIONS</TabBtn>
          <TabBtn active={tab === 'card'}      onClick={() => setTab('card')}>CREDIT CARD TRANSACTIONS</TabBtn>
          <TabBtn active={tab === 'gift'}      onClick={() => setTab('gift')}>GIFT TRANSACTIONS</TabBtn>
          <TabBtn active={tab === 'tickets'}   onClick={() => setTab('tickets')}>TICKET LIST</TabBtn>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="text-center font-mono text-xs text-gray-400 py-12">Computing balance…</div>
          ) : tab === 'summary' ? (
            <PaymentsSummary lines={lines} declaredCents={declaredCents} />
          ) : tab === 'reconcile' ? (
            <ReconcileCash
              expectedCashCents={expectedCashCents}
              count={closingCount}
              setCount={setClosingCount}
              declaredCents={declaredCents}
              varianceCents={varianceCents}
              varianceNote={varianceNote}
              setVarianceNote={setVarianceNote}
            />
          ) : tab === 'cash' ? (
            <PaymentTransactionsTab
              payments={allPayments.filter((p) => p.method === 'cash')}
              title="Cash transactions"
            />
          ) : tab === 'card' ? (
            <PaymentTransactionsTab
              payments={allPayments.filter((p) => p.method === 'visa_mc')}
              title="Credit card transactions"
            />
          ) : tab === 'gift' ? (
            <PaymentTransactionsTab
              payments={allPayments.filter((p) => p.method === 'gift')}
              title="Gift transactions"
            />
          ) : (
            <TicketListTab tickets={tickets} />
          )}
        </div>

        <div className="px-6 py-3 border-t border-gray-100 flex items-center justify-between gap-3 flex-wrap">
          {error && <p className="font-mono text-xs text-red-500 w-full">{error}</p>}
          <div className="flex items-center gap-2 flex-wrap">
            <label className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-wider text-gray-500">Closing as</span>
              <select
                value={receptionistId}
                onChange={(e) => { setReceptionistId(e.target.value); setPin(''); setError(null); }}
                className="px-2 py-1.5 rounded-lg border border-gray-200 font-mono text-xs bg-white focus:outline-none focus:ring-2 focus:ring-pink-300"
              >
                <option value="">Select…</option>
                {receptionists.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </label>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={(e) => { setPin(e.target.value); setError(null); }}
              placeholder="PIN"
              className="px-2 py-1.5 w-24 rounded-lg border border-gray-200 font-mono text-xs tracking-widest focus:outline-none focus:ring-2 focus:ring-pink-300"
            />
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={onClose}
              className="px-4 py-2 rounded-lg border border-gray-200 text-gray-600 font-mono text-xs font-bold hover:bg-gray-50">
              CANCEL
            </button>
            <button
              onClick={handleCloseShift}
              disabled={busy || hasOpenTickets || !receptionistId || pin.length === 0}
              title={hasOpenTickets ? 'Close all open tickets first' : undefined}
              className={`px-4 py-2 rounded-lg font-mono text-xs font-bold transition-colors ${
                hasOpenTickets
                  ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  : 'bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed'
              }`}
            >
              {busy
                ? 'CLOSING…'
                : hasOpenTickets
                  ? `${openTickets.length} TICKET${openTickets.length === 1 ? '' : 'S'} OPEN`
                  : 'CONTINUE TO CLOSE'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Banners ────────────────────────────────────────────────────────────────

function OpenTicketsBanner({ tickets }: { tickets: Ticket[] }) {
  return (
    <div className="mx-6 mt-3 mb-1 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3">
      <AlertTriangle size={18} className="text-amber-600 flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="font-mono text-sm font-bold text-amber-800">
          Please close ticket before closing day.
        </p>
        <p className="font-mono text-xs text-amber-700 mt-0.5">
          {tickets.length} open ticket{tickets.length === 1 ? '' : 's'}:{' '}
          {tickets
            .slice(0, 6)
            .map((t) => `#${t.ticketNumber} ${t.clientName || 'Walk-in'}`)
            .join(' · ')}
          {tickets.length > 6 ? ` · +${tickets.length - 6} more` : ''}
        </p>
      </div>
    </div>
  );
}

function ReadyBanner() {
  return (
    <div className="mx-6 mt-3 mb-1 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 flex items-center gap-3">
      <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0" />
      <p className="font-mono text-xs font-bold text-emerald-800">
        All tickets closed — continue to close the shift.
      </p>
    </div>
  );
}

// ── Tabs ───────────────────────────────────────────────────────────────────

function TabBtn({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 font-mono text-[11px] tracking-wider font-bold rounded-t-lg transition-colors ${
        active ? 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-gray-50'
      }`}
    >
      {children}
    </button>
  );
}

function PaymentsSummary({ lines, declaredCents }: { lines: ShiftBalanceLine[]; declaredCents: number }) {
  // Match the SalonBiz layout: simple table, zeros instead of dashes,
  // single Errors column populated only for cash (variance vs counted).
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="grid grid-cols-[90px_repeat(7,_1fr)] gap-1 px-3 py-2 bg-gray-100 border-b border-gray-200 font-mono text-[10px] tracking-wider font-semibold text-gray-500 uppercase">
        <span></span>
        <span className="text-right">Starting Balance</span>
        <span className="text-right"># of Pays</span>
        <span className="text-right">Payment Amount</span>
        <span className="text-right">Change Out</span>
        <span className="text-right">Drawer Entries</span>
        <span className="text-right">You Have</span>
        <span className="text-right">Errors</span>
      </div>
      {lines.map((line) => {
        const errorCents =
          line.method === 'cash' && declaredCents > 0
            ? declaredCents - line.youHaveCents
            : 0;
        return (
          <div key={line.method}
            className="grid grid-cols-[90px_repeat(7,_1fr)] gap-1 px-3 py-2.5 border-b border-gray-100 last:border-b-0 items-center bg-white">
            <span className="font-mono text-xs font-bold text-gray-900">
              {line.method === 'visa_mc' ? 'Visa/MC' : line.method[0].toUpperCase() + line.method.slice(1)}
            </span>
            <span className="font-mono text-sm text-gray-800 text-right tabular-nums">
              {formatMoneyCents(line.method === 'cash' ? line.startingBalanceCents : 0)}
            </span>
            <span className="font-mono text-sm text-gray-800 text-right tabular-nums">{line.paymentCount}</span>
            <span className="font-mono text-sm text-gray-800 text-right tabular-nums">{formatMoneyCents(line.paymentAmountCents)}</span>
            <span className="font-mono text-sm text-gray-800 text-right tabular-nums">
              {formatMoneyCents(line.method === 'cash' ? line.changeOutCents : 0)}
            </span>
            <span className="font-mono text-sm text-gray-800 text-right tabular-nums">
              {formatMoneyCents(line.method === 'cash' ? line.drawerEntriesCents : 0)}
            </span>
            <span className="font-mono text-sm font-bold text-gray-900 text-right tabular-nums">
              {formatMoneyCents(line.youHaveCents)}
            </span>
            <span className={`font-mono text-sm text-right tabular-nums font-semibold ${
              errorCents === 0 ? 'text-gray-400' : errorCents > 0 ? 'text-emerald-600' : 'bg-red-100 text-red-700 px-1 rounded'
            }`}>
              {formatMoneyCents(errorCents)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ReconcileCash({
  expectedCashCents, count, setCount, declaredCents, varianceCents,
  varianceNote, setVarianceNote,
}: {
  expectedCashCents: number;
  count: DenominationCount;
  setCount: (next: DenominationCount) => void;
  declaredCents: number;
  varianceCents: number;
  varianceNote: string;
  setVarianceNote: (v: string) => void;
}) {
  const isOver = varianceCents > 0;
  const isShort = varianceCents < 0;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
      <div className="flex flex-col gap-4">
        <p className="font-mono text-xs text-gray-500">
          Count the actual cash in the drawer by denomination. Variance = counted − expected.
        </p>
        <MoneyCountTable value={count} onChange={setCount} hideCoins billsAscending />
        <div>
          <label className="font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">
            Variance Note {varianceCents !== 0 && <span className="text-red-500">*required</span>}
          </label>
          <textarea
            value={varianceNote} onChange={(e) => setVarianceNote(e.target.value)}
            rows={3}
            className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 font-mono text-sm focus:outline-none focus:border-gray-400 resize-none"
            placeholder="e.g. tip-out paid in cash; missed pay-out entry"
          />
        </div>
      </div>
      <div className="bg-gray-50 rounded-xl p-5 flex flex-col gap-3 self-start">
        <Row label="Expected Cash" value={formatMoneyCents(expectedCashCents)} />
        <Row label="Counted Cash" value={formatMoneyCents(declaredCents)} />
        <div className="border-t border-gray-200 my-1" />
        <div className="flex items-center justify-between">
          <span className="font-mono text-xs text-gray-500">Variance</span>
          <span className={`font-mono text-lg font-bold ${
            isOver ? 'text-emerald-600' : isShort ? 'text-red-500' : 'text-gray-900'
          }`}>
            {(varianceCents > 0 ? '+' : '') + formatMoneyCents(varianceCents)}
          </span>
        </div>
        {varianceCents === 0 && declaredCents > 0 && (
          <p className="font-mono text-xs text-emerald-600 mt-1">✓ Drawer balances.</p>
        )}
      </div>
    </div>
  );
}

interface EnrichedPayment extends Payment {
  ticketNumber: number;
  ticketId: string;
  clientName: string;
  staffName: string;
}

type SortBy = 'customer' | 'amount' | 'ticket';

function PaymentTransactionsTab({
  payments,
  title,
}: {
  payments: EnrichedPayment[];
  title: string;
}) {
  const [sortBy, setSortBy] = useState<SortBy>('customer');

  const filtered = useMemo(() => {
    return [...payments].sort((a, b) => {
      if (sortBy === 'amount') return b.amountCents - a.amountCents;
      if (sortBy === 'ticket') return a.ticketNumber - b.ticketNumber;
      return a.clientName.localeCompare(b.clientName);
    });
  }, [payments, sortBy]);

  const total = filtered.reduce((s, p) => s + p.amountCents, 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <p className="font-bebas text-base tracking-widest text-gray-900">{title.toUpperCase()}</p>
        <span className="font-mono text-[10px] text-gray-400">{filtered.length} entries</span>
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <label className="flex items-center gap-2">
            <span className="font-mono text-[10px] font-bold text-gray-400 tracking-wider">SORT</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortBy)}
              className="px-2 py-1.5 rounded-lg border border-gray-200 font-mono text-xs bg-white focus:outline-none focus:border-gray-400"
            >
              <option value="customer">Customer</option>
              <option value="amount">Amount</option>
              <option value="ticket">Ticket #</option>
            </select>
          </label>
        </div>
      </div>

      <div className="border border-gray-100 rounded-xl overflow-hidden">
        <div className="grid grid-cols-[1fr_100px_90px_70px_140px] gap-2 px-3 py-2 bg-gray-50 border-b border-gray-100 font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">
          <span>Transaction For</span>
          <span className="text-right">Amount</span>
          <span>Type</span>
          <span className="text-right">Num</span>
          <span>Staff</span>
        </div>
        {filtered.length === 0 ? (
          <div className="px-3 py-10 text-center font-mono text-xs text-gray-400">
            No transactions.
          </div>
        ) : (
          filtered.map((p) => (
            <div key={p.id}
              className="grid grid-cols-[1fr_100px_90px_70px_140px] gap-2 px-3 py-2 border-b border-gray-50 last:border-b-0 items-center">
              <span className="font-mono text-sm text-gray-900 truncate">{p.clientName}</span>
              <span className="font-mono text-sm font-semibold text-gray-900 text-right">
                {formatMoneyCents(p.amountCents)}
              </span>
              <span>
                <MethodPill method={p.method} />
              </span>
              <span className="font-mono text-sm text-gray-700 text-right">#{p.ticketNumber}</span>
              <span className="font-mono text-sm text-gray-700 truncate">{p.staffName || '—'}</span>
            </div>
          ))
        )}
        <div className="grid grid-cols-[1fr_100px_90px_70px_140px] gap-2 px-3 py-2 bg-gray-50 border-t border-gray-100 items-center">
          <span className="font-mono text-[10px] tracking-wider font-bold text-gray-500 uppercase">Total</span>
          <span className="font-mono text-sm font-bold text-gray-900 text-right">{formatMoneyCents(total)}</span>
          <span /><span /><span />
        </div>
      </div>
    </div>
  );
}

function MethodPill({ method }: { method: PaymentMethod }) {
  const map: Record<PaymentMethod, string> = {
    cash:    'bg-emerald-50 text-emerald-700',
    visa_mc: 'bg-sky-50 text-sky-700',
    gift:    'bg-pink-50 text-pink-700',
  };
  const label: Record<PaymentMethod, string> = {
    cash: 'CASH', visa_mc: 'CARD', gift: 'GIFT',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full font-mono text-[10px] font-bold tracking-wider ${map[method]}`}>
      {label[method]}
    </span>
  );
}

function TicketListTab({ tickets }: { tickets: Ticket[] }) {
  const totalCents = tickets.reduce((s, t) => s + t.totalCents, 0);
  const sorted = useMemo(
    () => [...tickets].sort((a, b) => a.ticketNumber - b.ticketNumber),
    [tickets],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <p className="font-bebas text-base tracking-widest text-gray-900">TICKETS CLOSED THIS SHIFT</p>
        <span className="font-mono text-[10px] text-gray-400">{sorted.length} tickets</span>
        <span className="ml-auto font-mono text-sm font-bold text-gray-900">
          Total {formatMoneyCents(totalCents)}
        </span>
      </div>

      <div className="border border-gray-100 rounded-xl overflow-hidden">
        <div className="grid grid-cols-[60px_1fr_140px_1fr_100px_100px] gap-2 px-3 py-2 bg-gray-50 border-b border-gray-100 font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">
          <span>#</span>
          <span>Client</span>
          <span>Staff</span>
          <span>Services</span>
          <span className="text-right">Tip</span>
          <span className="text-right">Total</span>
        </div>
        {sorted.length === 0 ? (
          <div className="px-3 py-10 text-center font-mono text-xs text-gray-400">
            No tickets closed against this shift.
          </div>
        ) : (
          sorted.map((t) => (
            <div key={t.id}
              className="grid grid-cols-[60px_1fr_140px_1fr_100px_100px] gap-2 px-3 py-2 border-b border-gray-50 last:border-b-0 items-center">
              <span className="font-mono text-sm font-bold text-gray-900">#{t.ticketNumber}</span>
              <span className="font-mono text-sm text-gray-900 truncate">{t.clientName || 'Walk-in'}</span>
              <span className="font-mono text-xs text-gray-700 truncate">
                {t.primaryManicuristName || '—'}
              </span>
              <span className="font-mono text-[11px] text-gray-500 truncate">
                {t.items.length > 0 ? t.items.map((i) => i.name).join(', ') : '—'}
              </span>
              <span className="font-mono text-sm text-gray-700 text-right">
                {t.tipCents > 0 ? formatMoneyCents(t.tipCents) : '—'}
              </span>
              <span className="font-mono text-sm font-bold text-gray-900 text-right">
                {formatMoneyCents(t.totalCents)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="font-mono text-xs text-gray-500">{label}</span>
      <span className="font-mono text-base font-bold text-gray-900">{value}</span>
    </div>
  );
}
