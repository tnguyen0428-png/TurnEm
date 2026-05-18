// CloseShiftScreen — SalonBiz-mirrored Close Shift surface.
// (Editable payments + Sales Validation popup + confirm-close step)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronLeft, RefreshCw, X } from 'lucide-react';
import {
  closeShift,
  computeShiftBalance,
  type ShiftBalanceLine,
} from '../../lib/shifts';
import {
  formatMoneyCents,
  fetchTicketsForDate,
  fetchTicketsForShift,
  parseDollarsToCents,
  updatePayment,
} from '../../lib/tickets';
import type { Manicurist, Payment, PaymentMethod, Shift, Ticket } from '../../types';
import MoneyCountTable, {
  totalFromCount,
  type DenominationCount,
} from './MoneyCountTable';

interface Props {
  shift: Shift;
  receptionists: Manicurist[];
  onClose: () => void;
  onClosed: () => void;
}

type Tab = 'summary' | 'reconcile' | 'cash' | 'card' | 'gift' | 'tickets';

export default function CloseShiftScreen({ shift, receptionists, onClose, onClosed }: Props) {
  const isClosedShift = shift.status !== 'open';
  const [unlocked, setUnlocked] = useState(false);
  const isReadOnly = isClosedShift && !unlocked;

  const [tab, setTab] = useState<Tab>('summary');
  const [lines, setLines] = useState<ShiftBalanceLine[]>([]);
  const [expectedCashCents, setExpectedCashCents] = useState(
    isClosedShift ? (shift.expectedCashCents ?? 0) : 0,
  );
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
      setExpectedCashCents(isClosedShift ? (shift.expectedCashCents ?? balance.expectedCashCents) : balance.expectedCashCents);
    }
    setTickets(shiftTickets);
    setOpenTickets(dateTickets.filter((t) => t.status === 'open'));
    setLoading(false);
  }, [shift.id, shift.businessDate, isClosedShift, shift.expectedCashCents]);

  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  const [closingCount, setClosingCount] = useState<DenominationCount>(
    isClosedShift ? (shift.closingCount ?? {}) : {},
  );
  const declaredCents = totalFromCount(closingCount);
  const varianceCents = declaredCents - expectedCashCents;
  const [varianceNote, setVarianceNote] = useState(
    isClosedShift ? (shift.varianceNote ?? '') : '',
  );

  const [busy, setBusy] = useState(false);
  const [receptionistId, setReceptionistId] = useState<string>('');
  const [pin, setPin] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const hasOpenTickets = openTickets.length > 0;
  const pinRef = useRef<HTMLInputElement>(null);

  // Auto-focus the PIN field as soon as the close-shift surface opens AND
  // re-focus it whenever the receptionist dropdown changes (e.g. cashier
  // picks themselves after typing PIN). Either order works:
  //   - Type PIN first, then pick from dropdown
  //   - Pick from dropdown first, PIN gets focused
  // The setError dependency is intentionally omitted — only the mount and
  // receptionistId transitions should trigger focus.
  useEffect(() => {
    const t = setTimeout(() => pinRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [receptionistId]);

  // Three-step close:
  //   main       → editable shift summary (tabs incl. editable transactions)
  //   validation → SalonBiz-style Sales Validation popup
  //   confirm    → final "Do you want to close shift?" dialog
  const [step, setStep] = useState<'main' | 'validation' | 'confirm'>('main');

  function handleContinueToClose() {
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
    setStep('validation');
  }

  async function handleConfirmClose() {
    setError(null);
    const selected = receptionists.find((r) => r.id === receptionistId) ?? null;
    if (!selected) {
      setError('Pick a receptionist to attribute the close to.');
      setStep('main');
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
      setStep('main');
      return;
    }
    onClosed();
  }

  // Receipts breakdown — drives the Sales Validation popup totals.
  const breakdown = useMemo(() => {
    let services = 0;
    let retail = 0;
    let giftCert = 0;
    let lineDiscounts = 0;
    let tips = 0;
    let tax = 0;
    let ticketDiscounts = 0;
    for (const t of tickets) {
      if (t.status === 'voided') continue;
      for (const it of t.items) {
        const lineCents = it.unitPriceCents * it.quantity;
        const discount = it.discountCents ?? 0;
        if (it.kind === 'service') services += lineCents;
        else if (it.kind === 'retail') retail += lineCents;
        else if (it.kind === 'gift_card_sale') giftCert += lineCents;
        else if (it.kind === 'discount') lineDiscounts += lineCents;
        lineDiscounts += discount;
      }
      tips += t.tipCents ?? 0;
      tax += t.taxCents ?? 0;
      ticketDiscounts += t.discountCents ?? 0;
    }
    const series = 0; // not tracked (SalonBiz field — reserved for service packages)
    const discounts = lineDiscounts + ticketDiscounts;
    const subTotal = services + retail + giftCert + series - discounts;
    const totalReceipts = subTotal + tips + tax;
    return { services, retail, giftCert, series, discounts, subTotal, tips, tax, totalReceipts };
  }, [tickets]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const allPayments = useMemo<EnrichedPayment[]>(() => {
    const out: EnrichedPayment[] = [];
    for (const t of tickets) {
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
            <h2 className="font-bebas text-2xl tracking-widest text-gray-900">
              {isReadOnly ? 'SHIFT SUMMARY' : 'CLOSE SHIFT'}
            </h2>
            <p className="font-mono text-base text-gray-400 mt-0.5">
              Drawer #{shift.drawerNumber} — opened {new Date(shift.openedAt).toLocaleString()}
              {shift.openedByReceptionistId ? (
                <>
                  {' '}by{' '}
                  <span className="font-bold text-gray-600">
                    {receptionists.find((r) => r.id === shift.openedByReceptionistId)?.name ?? 'unknown'}
                  </span>
                </>
              ) : null}
              {isReadOnly && shift.closedAt ? (
                <>
                  {' '}· closed {new Date(shift.closedAt).toLocaleString()}
                  {shift.closedByReceptionistId ? (
                    <>
                      {' '}by{' '}
                      <span className="font-bold text-gray-600">
                        {receptionists.find((r) => r.id === shift.closedByReceptionistId)?.name ?? 'unknown'}
                      </span>
                    </>
                  ) : null}
                </>
              ) : null}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isClosedShift && !unlocked && (
              <button onClick={() => setUnlocked(true)}
                title="Unlock inputs and re-close with new values"
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 font-mono text-base font-bold tracking-wider">
                EDIT
              </button>
            )}
            {isClosedShift && unlocked && (
              <span className="px-2 py-1 rounded-md bg-amber-100 text-amber-800 font-mono text-base font-bold tracking-wider">
                EDITING
              </span>
            )}
            <button onClick={() => setRefreshKey((k) => k + 1)}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 font-mono text-base font-semibold tracking-wider">
              <RefreshCw size={11} /> REFRESH
            </button>
            <button onClick={onClose}
              className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
              <X size={18} />
            </button>
          </div>
        </div>

        {!loading && !isReadOnly && (
          hasOpenTickets ? (
            <OpenTicketsBanner tickets={openTickets} />
          ) : (
            <ReadyBanner />
          )
        )}

        <div className="px-6 pt-3 border-b border-gray-200 flex items-end gap-1 flex-nowrap overflow-x-auto">
          <TabBtn color="slate"   active={tab === 'summary'}   onClick={() => setTab('summary')}>SUMMARY</TabBtn>
          <TabBtn color="pink"    active={tab === 'reconcile'} onClick={() => setTab('reconcile')}>RECONCILE</TabBtn>
          <TabBtn color="emerald" active={tab === 'cash'}      onClick={() => setTab('cash')}>CASH</TabBtn>
          <TabBtn color="sky"     active={tab === 'card'}      onClick={() => setTab('card')}>CARD</TabBtn>
          <TabBtn color="amber"   active={tab === 'gift'}      onClick={() => setTab('gift')}>GIFT</TabBtn>
          <TabBtn color="violet"  active={tab === 'tickets'}   onClick={() => setTab('tickets')}>TICKETS</TabBtn>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="text-center font-mono text-base text-gray-400 py-12">Computing balance…</div>
          ) : tab === 'summary' ? (
            <PaymentsSummary lines={lines} declaredCents={declaredCents} breakdown={breakdown} />
          ) : tab === 'reconcile' ? (
            <ReconcileCash
              startingCashCents={lines.find((l) => l.method === 'cash')?.startingBalanceCents ?? 0}
              cashIntakeCents={lines.find((l) => l.method === 'cash')?.paymentAmountCents ?? 0}
              changeOutCents={lines.find((l) => l.method === 'cash')?.changeOutCents ?? 0}
              drawerEntriesCents={lines.find((l) => l.method === 'cash')?.drawerEntriesCents ?? 0}
              count={closingCount}
              setCount={setClosingCount}
              declaredCents={declaredCents}
              varianceCents={varianceCents}
              varianceNote={varianceNote}
              setVarianceNote={setVarianceNote}
              readOnly={isReadOnly}
            />
          ) : tab === 'cash' ? (
            <PaymentTransactionsTab
              payments={allPayments.filter((p) => p.method === 'cash')}
              title="Cash transactions"
              readOnly={isReadOnly}
              onUpdated={() => setRefreshKey((k) => k + 1)}
            />
          ) : tab === 'card' ? (
            <PaymentTransactionsTab
              payments={allPayments.filter((p) => p.method === 'visa_mc')}
              title="Credit card transactions"
              readOnly={isReadOnly}
              onUpdated={() => setRefreshKey((k) => k + 1)}
            />
          ) : tab === 'gift' ? (
            <PaymentTransactionsTab
              payments={allPayments.filter((p) => p.method === 'gift')}
              title="Gift transactions"
              readOnly={isReadOnly}
              onUpdated={() => setRefreshKey((k) => k + 1)}
            />
          ) : (
            <TicketListTab tickets={tickets} />
          )}
        </div>

        <div className="px-6 py-3 border-t border-gray-100 flex items-center justify-between gap-3 flex-wrap">
          {error && !isReadOnly && <p className="font-mono text-base text-red-500 w-full">{error}</p>}
          {isReadOnly ? (
            <div className="ml-auto flex items-center gap-2">
              <button onClick={onClose}
                className="px-4 py-2 rounded-lg bg-gray-900 text-white font-mono text-base font-bold hover:bg-gray-800">
                CLOSE
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <label className="flex items-center gap-2">
                  <span className="font-mono text-base uppercase tracking-wider text-gray-500">Closing as</span>
                  <select
                    value={receptionistId}
                    onChange={(e) => { setReceptionistId(e.target.value); setPin(''); setError(null); }}
                    className="px-2 py-1.5 rounded-lg border border-gray-200 font-mono text-base bg-white focus:outline-none focus:ring-2 focus:ring-pink-300"
                  >
                    <option value="">Select…</option>
                    {receptionists.map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </select>
                </label>
                <input
                  ref={pinRef}
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  value={pin}
                  onChange={(e) => { setPin(e.target.value); setError(null); }}
                  placeholder="PIN"
                  className="px-2 py-1.5 w-24 rounded-lg border border-gray-200 font-mono text-base tracking-widest focus:outline-none focus:ring-2 focus:ring-pink-300"
                />
              </div>
              <div className="ml-auto flex items-center gap-2">
                <button onClick={onClose}
                  className="px-4 py-2 rounded-lg border border-gray-200 text-gray-600 font-mono text-base font-bold hover:bg-gray-50">
                  CANCEL
                </button>
                <button
                  onClick={handleContinueToClose}
                  disabled={busy || hasOpenTickets || !receptionistId || pin.length === 0}
                  title={hasOpenTickets ? 'Close all open tickets first' : undefined}
                  className={`px-4 py-2 rounded-lg font-mono text-base font-bold transition-colors ${
                    hasOpenTickets
                      ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                      : 'bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed'
                  }`}
                >
                  {hasOpenTickets
                    ? `${openTickets.length} TICKET${openTickets.length === 1 ? '' : 'S'} OPEN`
                    : 'CONTINUE TO CLOSE'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {step === 'validation' && (
        <SalesValidationPopup
          shift={shift}
          breakdown={breakdown}
          lines={lines}
          expectedCashCents={expectedCashCents}
          declaredCents={declaredCents}
          varianceCents={varianceCents}
          onBack={() => { setStep('main'); setError(null); }}
          onContinue={() => setStep('confirm')}
        />
      )}

      {step === 'confirm' && (
        <ConfirmCloseDialog
          busy={busy}
          onCancel={() => { if (!busy) setStep('validation'); }}
          onConfirm={() => void handleConfirmClose()}
        />
      )}
    </div>
  );
}

function OpenTicketsBanner({ tickets }: { tickets: Ticket[] }) {
  return (
    <div className="mx-6 mt-3 mb-1 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3">
      <AlertTriangle size={18} className="text-amber-600 flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="font-mono text-base font-bold text-amber-800">
          Please close ticket before closing day.
        </p>
        <p className="font-mono text-base text-amber-700 mt-0.5">
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
      <p className="font-mono text-base font-bold text-emerald-800">
        All tickets closed — continue to close the shift.
      </p>
    </div>
  );
}

type TabColor = 'slate' | 'pink' | 'emerald' | 'sky' | 'amber' | 'violet';

const TAB_PALETTE: Record<TabColor, { active: string; inactive: string }> = {
  slate:   { active: 'bg-slate-700 text-white border-slate-700',     inactive: 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200' },
  pink:    { active: 'bg-pink-500 text-white border-pink-500',       inactive: 'bg-pink-50 text-pink-700 border-pink-200 hover:bg-pink-100' },
  emerald: { active: 'bg-emerald-500 text-white border-emerald-500', inactive: 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100' },
  sky:     { active: 'bg-sky-500 text-white border-sky-500',         inactive: 'bg-sky-50 text-sky-700 border-sky-200 hover:bg-sky-100' },
  amber:   { active: 'bg-amber-500 text-white border-amber-500',     inactive: 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100' },
  violet:  { active: 'bg-violet-500 text-white border-violet-500',   inactive: 'bg-violet-50 text-violet-700 border-violet-200 hover:bg-violet-100' },
};

function TabBtn({
  active, children, onClick, color = 'slate',
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
  color?: TabColor;
}) {
  const palette = TAB_PALETTE[color];
  // Folder-tab look:
  //  - rounded top corners only (rounded-t-lg)
  //  - border on top + sides; bottom border is transparent on the active tab
  //    so it visually merges with the content area below
  //  - active tab lifts via -mb-px so its bottom edge sits on top of the
  //    container border, completing the folder-tab silhouette
  const base = 'px-4 py-2 font-mono text-base tracking-wider font-bold whitespace-nowrap rounded-t-lg border-t border-l border-r transition-colors';
  const state = active
    ? `${palette.active} -mb-px border-b border-b-transparent shadow-sm relative z-10`
    : `${palette.inactive} border-b-0`;
  return (
    <button onClick={onClick} className={`${base} ${state}`}>
      {children}
    </button>
  );
}

function PaymentsSummary({
  lines, declaredCents, breakdown,
}: {
  lines: ShiftBalanceLine[];
  declaredCents: number;
  breakdown: Breakdown;
}) {
  const totals = lines.reduce((acc, l) => {
    const errorCents = l.method === 'cash' && declaredCents > 0 ? declaredCents - l.youHaveCents : 0;
    return {
      startingBalance: acc.startingBalance + (l.method === 'cash' ? l.startingBalanceCents : 0),
      paymentCount: acc.paymentCount + l.paymentCount,
      paymentAmount: acc.paymentAmount + l.paymentAmountCents,
      changeOut: acc.changeOut + (l.method === 'cash' ? l.changeOutCents : 0),
      drawerEntries: acc.drawerEntries + (l.method === 'cash' ? l.drawerEntriesCents : 0),
      youHave: acc.youHave + l.youHaveCents,
      errors: acc.errors + errorCents,
    };
  }, { startingBalance: 0, paymentCount: 0, paymentAmount: 0, changeOut: 0, drawerEntries: 0, youHave: 0, errors: 0 });

  const serviceSalesCents = breakdown.services;
  const giftSalesCents = breakdown.giftCert;
  const discountsCents = breakdown.discounts;
  // Grand total = service + gift, net of any discounts applied.
  const grandTotalCents = serviceSalesCents + giftSalesCents - discountsCents;

  return (
    <div className="flex flex-col gap-4">
      <div className="border border-gray-200 rounded-lg overflow-hidden">
        <div className="grid grid-cols-[90px_repeat(7,_1fr)] gap-1 px-3 py-2 bg-gray-100 border-b border-gray-200 font-mono text-base tracking-wider font-semibold text-gray-500 uppercase">
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
              className="grid grid-cols-[90px_repeat(7,_1fr)] gap-1 px-3 py-2.5 border-b border-gray-100 items-center bg-white">
              <span className="font-mono text-base font-bold text-gray-900">
                {line.method === 'visa_mc' ? 'Visa/MC' : line.method[0].toUpperCase() + line.method.slice(1)}
              </span>
              <span className="font-mono text-base text-gray-800 text-right tabular-nums">
                {formatMoneyCents(line.method === 'cash' ? line.startingBalanceCents : 0)}
              </span>
              <span className="font-mono text-base text-gray-800 text-right tabular-nums">{line.paymentCount}</span>
              <span className="font-mono text-base text-gray-800 text-right tabular-nums">{formatMoneyCents(line.paymentAmountCents)}</span>
              <span className="font-mono text-base text-gray-800 text-right tabular-nums">
                {formatMoneyCents(line.method === 'cash' ? line.changeOutCents : 0)}
              </span>
              <span className="font-mono text-base text-gray-800 text-right tabular-nums">
                {formatMoneyCents(line.method === 'cash' ? line.drawerEntriesCents : 0)}
              </span>
              <span className="font-mono text-base font-bold text-gray-900 text-right tabular-nums">
                {formatMoneyCents(line.youHaveCents)}
              </span>
              <span className={`font-mono text-base text-right tabular-nums font-semibold ${
                errorCents === 0 ? 'text-gray-400' : errorCents > 0 ? 'text-emerald-600' : 'bg-red-100 text-red-700 px-1 rounded'
              }`}>
                {formatMoneyCents(errorCents)}
              </span>
            </div>
          );
        })}
        {/* Column totals — sums each numeric column across cash/card/gift. */}
        <div className="grid grid-cols-[90px_repeat(7,_1fr)] gap-1 px-3 py-2.5 bg-gray-50 border-t-2 border-gray-300 items-center">
          <span className="font-mono text-base tracking-wider font-bold text-gray-700 uppercase">Total</span>
          <span className="font-mono text-base font-bold text-gray-900 text-right tabular-nums">{formatMoneyCents(totals.startingBalance)}</span>
          <span className="font-mono text-base font-bold text-gray-900 text-right tabular-nums">{totals.paymentCount}</span>
          <span className="font-mono text-base font-bold text-gray-900 text-right tabular-nums">{formatMoneyCents(totals.paymentAmount)}</span>
          <span className="font-mono text-base font-bold text-gray-900 text-right tabular-nums">{formatMoneyCents(totals.changeOut)}</span>
          <span className="font-mono text-base font-bold text-gray-900 text-right tabular-nums">{formatMoneyCents(totals.drawerEntries)}</span>
          <span className="font-mono text-base font-bold text-gray-900 text-right tabular-nums">{formatMoneyCents(totals.youHave)}</span>
          <span className={`font-mono text-base font-bold text-right tabular-nums ${
            totals.errors === 0 ? 'text-gray-400' : totals.errors > 0 ? 'text-emerald-600' : 'text-red-700'
          }`}>
            {totals.errors !== 0 ? formatMoneyCents(totals.errors) : '—'}
          </span>
        </div>
      </div>

      {/* Sales breakdown — service revenue + gift-card-sale revenue + grand
          total. Item-side summary, derived from ticket_items by kind. */}
      <div className="border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-gray-100 border-b border-gray-200 font-mono text-base tracking-wider font-semibold text-gray-500 uppercase">
          Sales Breakdown
        </div>
        <div className="px-3 py-2.5 flex items-center justify-between border-b border-gray-100">
          <span className="font-mono text-base text-gray-700">Service Sales Total</span>
          <span className="font-mono text-base font-bold text-gray-900 tabular-nums">{formatMoneyCents(serviceSalesCents)}</span>
        </div>
        <div className="px-3 py-2.5 flex items-center justify-between border-b border-gray-100">
          <span className="font-mono text-base text-gray-700">Gift Sales Total</span>
          <span className="font-mono text-base font-bold text-gray-900 tabular-nums">{formatMoneyCents(giftSalesCents)}</span>
        </div>
        <div className="px-3 py-2.5 flex items-center justify-between border-b border-gray-100">
          <span className="font-mono text-base text-gray-700">Discounts</span>
          <span className="font-mono text-base font-bold text-red-600 tabular-nums">−{formatMoneyCents(discountsCents)}</span>
        </div>
        <div className="px-3 py-2.5 flex items-center justify-between bg-gray-50 border-t-2 border-gray-300">
          <span className="font-mono text-base tracking-wider font-bold text-gray-700 uppercase">Grand Total</span>
          <span className="font-mono text-base font-bold text-gray-900 tabular-nums">{formatMoneyCents(grandTotalCents)}</span>
        </div>
      </div>
    </div>
  );
}

// Cash float left in the drawer at end of shift. Anything counted above this
// is the deposit ("Amount to take out"). Hard-coded for now; lift to settings
// if it ever needs to vary per salon.
const REGISTER_FLOAT_CENTS = 40000;

function ReconcileCash({
  startingCashCents, cashIntakeCents, changeOutCents, drawerEntriesCents,
  count, setCount, declaredCents, varianceCents,
  varianceNote, setVarianceNote, readOnly = false,
}: {
  startingCashCents: number;
  cashIntakeCents: number;
  changeOutCents: number;
  drawerEntriesCents: number;
  count: DenominationCount;
  setCount: (next: DenominationCount) => void;
  declaredCents: number;
  varianceCents: number;
  varianceNote: string;
  setVarianceNote: (v: string) => void;
  readOnly?: boolean;
}) {
  const isOver = varianceCents > 0;
  const isShort = varianceCents < 0;
  const takeOutCents = Math.max(0, declaredCents - REGISTER_FLOAT_CENTS);
  return (
    <div className="flex flex-col gap-5">
      <p className="font-mono text-base text-gray-500">
        {readOnly
          ? 'Closing denomination count recorded at end of shift.'
          : 'Count the actual cash in the drawer by denomination. Variance = counted − expected.'}
      </p>

      {/* Two equal-size cards side by side: Bills Count + Expected/Counted/Variance.
          Wrapped in identical bg-gray-50 rounded-xl containers so they read as a
          matched pair. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-stretch">
        <div className="bg-gray-50 rounded-xl p-5 flex flex-col gap-3">
          <h3 className="font-mono text-base tracking-wider font-semibold text-gray-500 uppercase">
            Bills Count
          </h3>
          <MoneyCountTable value={count} onChange={setCount} disabled={readOnly} hideCoins billsAscending />
        </div>
        <div className="bg-gray-50 rounded-xl p-5 flex flex-col gap-2">
          <h3 className="font-mono text-base tracking-wider font-semibold text-gray-700 uppercase">
            Expected vs Counted
          </h3>

          {/* Cash build-up: where the expected drawer total came from.
              Labels and values share the same text-base size so the card reads
              as a balanced grid rather than tiny-label / big-number rows. */}
          <div className="flex items-center justify-between">
            <span className="font-mono text-base text-gray-700">Starting Cash</span>
            <span className="font-mono text-base font-bold text-gray-900 tabular-nums">{formatMoneyCents(startingCashCents)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="font-mono text-base text-gray-700">Cash Intake</span>
            <span className="font-mono text-base font-bold text-gray-900 tabular-nums">+{formatMoneyCents(cashIntakeCents)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="font-mono text-base text-gray-700">Change Given</span>
            <span className="font-mono text-base font-bold text-gray-900 tabular-nums">−{formatMoneyCents(changeOutCents)}</span>
          </div>
          {drawerEntriesCents !== 0 && (
            <div className="flex items-center justify-between">
              <span className="font-mono text-base text-gray-700">{drawerEntriesCents > 0 ? 'Pay-In' : 'Pay-Out'}</span>
              <span className="font-mono text-base font-bold text-gray-900 tabular-nums">{(drawerEntriesCents > 0 ? '+' : '−') + formatMoneyCents(Math.abs(drawerEntriesCents))}</span>
            </div>
          )}

          <div className="border-t border-gray-200 my-1" />

          {/* Reconciliation: what's actually in the drawer vs what should be. */}
          <div className="flex items-center justify-between">
            <span className="font-mono text-base text-gray-700">Register Count Total</span>
            <span className="font-mono text-base font-bold text-gray-900 tabular-nums">{formatMoneyCents(declaredCents)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="font-mono text-base text-gray-700">Cash Error</span>
            <span className={`font-mono text-base font-bold tabular-nums ${
              isOver ? 'text-emerald-600' : isShort ? 'text-red-500' : 'text-gray-900'
            }`}>
              {(varianceCents > 0 ? '+' : '') + formatMoneyCents(varianceCents)}
            </span>
          </div>
          {varianceCents === 0 && declaredCents > 0 && (
            <p className="font-mono text-base text-emerald-600">✓ Drawer balances.</p>
          )}

          <div className="border-t border-gray-200 my-1" />

          {/* Deposit split: float stays in the register, the rest comes out. */}
          <div className="flex items-center justify-between">
            <span className="font-mono text-base text-gray-700">Leave in Register</span>
            <span className="font-mono text-base font-bold text-gray-900 tabular-nums">{formatMoneyCents(REGISTER_FLOAT_CENTS)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="font-mono text-base text-gray-700">Amount to Take Out</span>
            <span className="font-mono text-base font-bold text-gray-900 tabular-nums">{formatMoneyCents(takeOutCents)}</span>
          </div>
        </div>
      </div>

      <div>
        <label className="font-mono text-base tracking-wider font-semibold text-gray-400 uppercase">
          Variance Note {!readOnly && varianceCents !== 0 && <span className="text-red-500">*required</span>}
        </label>
        {readOnly ? (
          <p className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 bg-gray-50 font-mono text-base text-gray-700 min-h-[72px] whitespace-pre-wrap">
            {varianceNote.trim() ? varianceNote : <span className="text-gray-400">— none —</span>}
          </p>
        ) : (
          <textarea
            value={varianceNote} onChange={(e) => setVarianceNote(e.target.value)}
            rows={3}
            className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 font-mono text-base focus:outline-none focus:border-gray-400 resize-none"
            placeholder="e.g. tip-out paid in cash; missed pay-out entry"
          />
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
  payments, title, readOnly = true, onUpdated,
}: {
  payments: EnrichedPayment[];
  title: string;
  readOnly?: boolean;
  onUpdated?: () => void;
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
        <span className="font-mono text-base text-gray-400">{filtered.length} entries</span>
        {!readOnly && (
          <span className="font-mono text-base text-pink-600 font-semibold">CLICK AMOUNT TO EDIT</span>
        )}
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <label className="flex items-center gap-2">
            <span className="font-mono text-base font-bold text-gray-400 tracking-wider">SORT</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortBy)}
              className="px-2 py-1.5 rounded-lg border border-gray-200 font-mono text-base bg-white focus:outline-none focus:border-gray-400"
            >
              <option value="customer">Customer</option>
              <option value="amount">Amount</option>
              <option value="ticket">Ticket #</option>
            </select>
          </label>
        </div>
      </div>

      <div className="border border-gray-100 rounded-xl overflow-hidden">
        <div className="grid grid-cols-[1fr_100px_90px_70px_140px] gap-2 px-3 py-2 bg-gray-50 border-b border-gray-100 font-mono text-base tracking-wider font-semibold text-gray-400 uppercase">
          <span>Transaction For</span>
          <span className="text-right">Amount</span>
          <span>Type</span>
          <span className="text-right">Num</span>
          <span>Staff</span>
        </div>
        {filtered.length === 0 ? (
          <div className="px-3 py-10 text-center font-mono text-base text-gray-400">
            No transactions.
          </div>
        ) : (
          filtered.map((p) => (
            <PaymentRow key={p.id} payment={p} readOnly={readOnly} onUpdated={onUpdated} />
          ))
        )}
        <div className="grid grid-cols-[1fr_100px_90px_70px_140px] gap-2 px-3 py-2 bg-gray-50 border-t border-gray-100 items-center">
          <span className="font-mono text-base tracking-wider font-bold text-gray-500 uppercase">Total</span>
          <span className="font-mono text-base font-bold text-gray-900 text-right">{formatMoneyCents(total)}</span>
          <span /><span /><span />
        </div>
      </div>
    </div>
  );
}

function PaymentRow({
  payment, readOnly, onUpdated,
}: {
  payment: EnrichedPayment;
  readOnly: boolean;
  onUpdated?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState((payment.amountCents / 100).toFixed(2));
  const [saving, setSaving] = useState(false);

  function startEdit() {
    if (readOnly || saving) return;
    setInput((payment.amountCents / 100).toFixed(2));
    setEditing(true);
  }

  async function commit() {
    const nextCents = parseDollarsToCents(input);
    if (nextCents === payment.amountCents) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const ok = await updatePayment(payment.id, nextCents);
    setSaving(false);
    setEditing(false);
    if (ok) onUpdated?.();
  }

  function cancel() {
    setInput((payment.amountCents / 100).toFixed(2));
    setEditing(false);
  }

  return (
    <div className="grid grid-cols-[1fr_100px_90px_70px_140px] gap-2 px-3 py-2 border-b border-gray-50 last:border-b-0 items-center">
      <span className="font-mono text-base text-gray-900 truncate">{payment.clientName}</span>
      {editing ? (
        <input
          autoFocus
          type="text"
          inputMode="decimal"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') cancel();
          }}
          className="px-2 py-1 rounded-md border border-pink-300 bg-white font-mono text-base font-semibold text-gray-900 text-right focus:outline-none focus:ring-2 focus:ring-pink-300 w-full"
        />
      ) : (
        <button
          type="button"
          onClick={startEdit}
          disabled={readOnly}
          className={`font-mono text-base font-semibold text-right tabular-nums ${
            readOnly
              ? 'text-gray-900 cursor-default'
              : 'text-gray-900 hover:bg-pink-50 hover:ring-1 hover:ring-pink-200 rounded-md px-1 cursor-text'
          } ${saving ? 'opacity-50' : ''}`}
          title={readOnly ? undefined : 'Click to edit'}
        >
          {formatMoneyCents(payment.amountCents)}
        </button>
      )}
      <span>
        <MethodPill method={payment.method} />
      </span>
      <span className="font-mono text-base text-gray-700 text-right">#{payment.ticketNumber}</span>
      <span className="font-mono text-base text-gray-700 truncate">{payment.staffName || '—'}</span>
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
    <span className={`inline-block px-2 py-0.5 rounded-full font-mono text-base font-bold tracking-wider ${map[method]}`}>
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
        <span className="font-mono text-base text-gray-400">{sorted.length} tickets</span>
        <span className="ml-auto font-mono text-base font-bold text-gray-900">
          Total {formatMoneyCents(totalCents)}
        </span>
      </div>

      <div className="border border-gray-100 rounded-xl overflow-hidden">
        <div className="grid grid-cols-[60px_1fr_140px_1fr_100px_100px] gap-2 px-3 py-2 bg-gray-50 border-b border-gray-100 font-mono text-base tracking-wider font-semibold text-gray-400 uppercase">
          <span>#</span>
          <span>Client</span>
          <span>Staff</span>
          <span>Services</span>
          <span className="text-right">Tip</span>
          <span className="text-right">Total</span>
        </div>
        {sorted.length === 0 ? (
          <div className="px-3 py-10 text-center font-mono text-base text-gray-400">
            No tickets closed against this shift.
          </div>
        ) : (
          sorted.map((t) => (
            <div key={t.id}
              className="grid grid-cols-[60px_1fr_140px_1fr_100px_100px] gap-2 px-3 py-2 border-b border-gray-50 last:border-b-0 items-center">
              <span className="font-mono text-base font-bold text-gray-900">#{t.ticketNumber}</span>
              <span className="font-mono text-base text-gray-900 truncate">{t.clientName || 'Walk-in'}</span>
              <span className="font-mono text-base text-gray-700 truncate">
                {t.primaryManicuristName || '—'}
              </span>
              <span className="font-mono text-base text-gray-500 truncate">
                {t.items.length > 0 ? t.items.map((i) => i.name).join(', ') : '—'}
              </span>
              <span className="font-mono text-base text-gray-700 text-right">
                {t.tipCents > 0 ? formatMoneyCents(t.tipCents) : '—'}
              </span>
              <span className="font-mono text-base font-bold text-gray-900 text-right">
                {formatMoneyCents(t.totalCents)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── Sales Validation popup (SalonBiz-style "Close Day" review) ───────────────
//
// Shown after the editable Shift Summary; mirrors the SalonBiz layout with
// four sub-tabs: Payment Summary, Sales Validation, Bank Deposit,
// Reports & Overnight. The Sales Validation tab is the focal view —
// Receipts on the left, Payments on the right, Error centered below.

interface Breakdown {
  services: number;
  retail: number;
  giftCert: number;
  series: number;
  discounts: number;
  subTotal: number;
  tips: number;
  tax: number;
  totalReceipts: number;
}

type ValidationTab = 'payments' | 'validation' | 'reports';

function SalesValidationPopup({
  shift, breakdown, lines, expectedCashCents, declaredCents, varianceCents,
  onBack, onContinue,
}: {
  shift: Shift;
  breakdown: Breakdown;
  lines: ShiftBalanceLine[];
  expectedCashCents: number;
  declaredCents: number;
  varianceCents: number;
  onBack: () => void;
  onContinue: () => void;
}) {
  const [vtab, setVtab] = useState<ValidationTab>('payments');

  // Payments by method. SalonBiz tracks Check separately; our schema doesn't
  // (yet), so Check shows $0 — placeholder kept so the layout matches the
  // screenshot the user referenced.
  const payByMethod = useMemo(() => {
    const m: Record<'cash' | 'visa_mc' | 'gift', number> = { cash: 0, visa_mc: 0, gift: 0 };
    for (const l of lines) m[l.method] = l.paymentAmountCents;
    return m;
  }, [lines]);
  const checkCents = 0;
  const totalPayments = payByMethod.cash + checkCents + payByMethod.gift + payByMethod.visa_mc;

  const cashLine = lines.find((l) => l.method === 'cash');
  const startingPlusDrawer = (cashLine?.startingBalanceCents ?? 0) + (cashLine?.drawerEntriesCents ?? 0);
  const totalYouHave = totalPayments + startingPlusDrawer - (cashLine?.changeOutCents ?? 0);
  // Cash that physically goes in the bank envelope = cash collected during
  // the day minus the starting bank that stays in the drawer for tomorrow.
  // Equivalent to: (drawer cash at close) - starting balance.
  const envelopeCashCents =
    payByMethod.cash
    - (cashLine?.changeOutCents ?? 0)
    + (cashLine?.drawerEntriesCents ?? 0);
  // Validation error: Total Payments should equal Total Receipts (cash math
  // matches sales math). Non-zero flags a missing payment or a mis-entered
  // amount.
  const errorCents = totalPayments - breakdown.totalReceipts;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col animate-modal-in">
        <div className="px-6 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-bebas text-2xl tracking-widest text-gray-900">CLOSE DAY</h2>
          <button onClick={onBack}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600"
            title="Back to Shift Summary">
            <X size={18} />
          </button>
        </div>

        <div className="px-6 pt-2 border-b border-gray-100 flex items-center gap-1 flex-nowrap overflow-x-auto">
          <TabBtn color="slate" active={vtab === 'payments'}   onClick={() => setVtab('payments')}>PAYMENTS</TabBtn>
          <TabBtn color="pink"  active={vtab === 'validation'} onClick={() => setVtab('validation')}>VALIDATION</TabBtn>
          <TabBtn color="sky"   active={vtab === 'reports'}    onClick={() => setVtab('reports')}>REPORTS</TabBtn>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {vtab === 'validation' ? (
            <SalesValidationTab
              breakdown={breakdown}
              payByMethod={payByMethod}
              totalPayments={totalPayments}
              totalYouHave={totalYouHave}
              startingPlusDrawer={startingPlusDrawer}
              startingCashCents={cashLine?.startingBalanceCents ?? 0}
              envelopeCashCents={envelopeCashCents}
              errorCents={errorCents}
            />
          ) : vtab === 'payments' ? (
            <PaymentSummaryTab
              lines={lines}
              expectedCashCents={expectedCashCents}
              declaredCents={declaredCents}
              varianceCents={varianceCents}
              breakdown={breakdown}
            />
          ) : (
            <ReportsOvernightTab shift={shift} totalReceiptsCents={breakdown.totalReceipts} />
          )}
        </div>

        <div className="px-6 py-3 border-t border-gray-100 flex items-center justify-between gap-3">
          <button onClick={onBack}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-gray-200 text-gray-600 font-mono text-base font-bold hover:bg-gray-50">
            <ChevronLeft size={14} /> BACK TO SUMMARY
          </button>
          <div className="ml-auto flex items-center gap-3">
            {errorCents !== 0 && (
              <span className="font-mono text-base font-bold text-red-600">
                ERROR {formatMoneyCents(errorCents)} — verify before closing
              </span>
            )}
            <button
              onClick={() => {
                // Walk the tabs in order; the last tab triggers the final
                // confirm-close dialog.
                if (vtab === 'payments') setVtab('validation');
                else if (vtab === 'validation') setVtab('reports');
                else onContinue();
              }}
              className="px-6 py-2 rounded-full bg-pink-500 text-white font-mono text-base font-bold hover:bg-pink-600 active:scale-[0.98] transition-all shadow-sm">
              {vtab === 'reports' ? 'CONFIRM CLOSING' : 'CONTINUE'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SalesValidationTab({
  breakdown, payByMethod, totalPayments,
  totalYouHave, startingPlusDrawer, startingCashCents, envelopeCashCents, errorCents,
}: {
  breakdown: Breakdown;
  payByMethod: Record<'cash' | 'visa_mc' | 'gift', number>;
  totalPayments: number;
  totalYouHave: number;
  startingPlusDrawer: number;
  startingCashCents: number;
  envelopeCashCents: number;
  errorCents: number;
}) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl border border-gray-200 overflow-hidden">
          <div className="bg-gray-50 px-4 py-2 border-b border-gray-200">
            <span className="font-mono text-base tracking-wider font-bold text-gray-500 uppercase">Receipts</span>
          </div>
          <div className="px-4 py-3 space-y-2">
            <SummaryRow label="Services"   value={breakdown.services} />
            <SummaryRow label="Gift Cert." value={breakdown.giftCert} />
            <div className="border-t border-gray-200 my-2" />
            <SummaryRow label="Sub Total"  value={breakdown.subTotal} bold />
            <SummaryRow label="Tips"       value={breakdown.tips} />
            <SummaryRow label="Tax"        value={breakdown.tax} />
            <div className="border-t border-gray-200 my-2" />
            <SummaryRow label="Total Receipts" value={breakdown.totalReceipts} bold accent />
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 overflow-hidden">
          <div className="bg-gray-50 px-4 py-2 border-b border-gray-200 grid grid-cols-2">
            <span className="font-mono text-base tracking-wider font-bold text-gray-500 uppercase">Payment Type</span>
            <span className="font-mono text-base tracking-wider font-bold text-gray-500 uppercase text-right">Amount</span>
          </div>
          <div className="px-4 py-3 space-y-2">
            <SummaryRow label="Cash"    value={payByMethod.cash} />
            <SummaryRow label="Gift"    value={payByMethod.gift} />
            <SummaryRow label="Visa/MC" value={payByMethod.visa_mc} />
            <div className="border-t border-gray-200 my-2" />
            <SummaryRow label="Total You Have" value={totalYouHave} bold />
            <SummaryRow label="Less Starting Cash & Drawer Entries" value={startingPlusDrawer} />
            <div className="border-t border-gray-200 my-2" />
            <SummaryRow label="Total Payments" value={totalPayments} bold accent />
            <div className="mt-2 flex items-center justify-between rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2">
              <div className="flex flex-col">
                <span className="font-mono text-base font-bold text-emerald-800">Cash in Envelope</span>
                <span className="font-mono text-base text-emerald-700">
                  (less starting cash {formatMoneyCents(startingCashCents)})
                </span>
              </div>
              <span className="font-mono text-lg font-bold text-emerald-700 tabular-nums">
                {formatMoneyCents(envelopeCashCents)}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-center gap-3 pt-1">
        <span className="font-mono text-base tracking-wider font-bold text-gray-500 uppercase">Error</span>
        <span className={`font-mono text-lg font-bold tabular-nums ${
          errorCents === 0 ? 'text-gray-700' : 'text-red-600'
        }`}>
          {formatMoneyCents(errorCents)}
        </span>
      </div>
    </div>
  );
}

function PaymentSummaryTab({
  lines, expectedCashCents, declaredCents, varianceCents, breakdown,
}: {
  lines: ShiftBalanceLine[];
  expectedCashCents: number;
  declaredCents: number;
  varianceCents: number;
  breakdown: Breakdown;
}) {
  return (
    <div className="space-y-4">
      <PaymentsSummary lines={lines} declaredCents={declaredCents} breakdown={breakdown} />
      <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 grid grid-cols-3 gap-4 text-center">
        <div>
          <p className="font-mono text-base tracking-wider font-bold text-gray-500 uppercase">Expected Cash</p>
          <p className="font-mono text-base font-bold text-gray-900 tabular-nums">{formatMoneyCents(expectedCashCents)}</p>
        </div>
        <div>
          <p className="font-mono text-base tracking-wider font-bold text-gray-500 uppercase">Counted Cash</p>
          <p className="font-mono text-base font-bold text-gray-900 tabular-nums">{formatMoneyCents(declaredCents)}</p>
        </div>
        <div>
          <p className="font-mono text-base tracking-wider font-bold text-gray-500 uppercase">Variance</p>
          <p className={`font-mono text-base font-bold tabular-nums ${
            varianceCents === 0 ? 'text-gray-900' : varianceCents > 0 ? 'text-emerald-600' : 'text-red-600'
          }`}>
            {(varianceCents > 0 ? '+' : '') + formatMoneyCents(varianceCents)}
          </p>
        </div>
      </div>
    </div>
  );
}


function ReportsOvernightTab({
  shift, totalReceiptsCents,
}: {
  shift: Shift;
  totalReceiptsCents: number;
}) {
  // Format the business date like "Wednesday, May 13, 2026".
  const prettyDate = useMemo(() => {
    const [y, m, d] = shift.businessDate.split('-').map(Number);
    if (!y || !m || !d) return shift.businessDate;
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
  }, [shift.businessDate]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-200 overflow-hidden">
        <div className="bg-gray-50 px-4 py-2 border-b border-gray-200">
          <span className="font-mono text-base tracking-wider font-bold text-gray-500 uppercase">End-of-Day Reports</span>
        </div>
        <div className="px-4 py-3 space-y-3">
          <div className="text-center py-2">
            <p className="font-bebas text-2xl tracking-widest text-pink-600">
              {prettyDate}
            </p>
          </div>
          <p className="font-mono text-base text-gray-600">
            After closing, end-of-day reports will be available in the Blueprint
            section (Sales, Staff, Manicurist Sales, Gift Certificates,
            Receptionist Hours).
          </p>
          <div className="rounded-lg bg-gray-50 px-3 py-2 max-w-xs mx-auto text-center">
            <p className="font-mono text-base tracking-wider font-bold text-gray-500 uppercase">Total Receipts</p>
            <p className="font-mono text-base font-bold text-gray-900 tabular-nums">{formatMoneyCents(totalReceiptsCents)}</p>
          </div>
        </div>
      </div>
      <p className="font-mono text-base text-gray-400 text-center">
        Overnight processing runs automatically once the shift closes.
      </p>
    </div>
  );
}

function SummaryRow({
  label, value, bold = false, accent = false,
}: {
  label: string;
  value: number;
  bold?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={`font-mono text-base ${bold ? 'font-bold text-gray-900' : 'text-gray-700'}`}>{label}</span>
      <span className={`font-mono ${bold ? 'text-base font-bold' : 'text-base'} ${accent ? 'text-pink-600' : 'text-gray-900'} tabular-nums`}>
        {formatMoneyCents(value)}
      </span>
    </div>
  );
}

// ── Final confirm dialog ─────────────────────────────────────────────────────

function ConfirmCloseDialog({
  busy, onCancel, onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md flex flex-col animate-modal-in">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-3">
          <AlertTriangle size={20} className="text-amber-500" />
          <h2 className="font-bebas text-xl tracking-widest text-gray-900">CLOSE SHIFT?</h2>
        </div>
        <div className="px-6 py-5">
          <p className="font-mono text-base text-gray-800">
            Do you want to close shift?
          </p>
          <p className="font-mono text-base text-gray-500 mt-2 leading-relaxed">
            Once closed, the drawer is sealed for the day. Payments and tickets
            on this shift become read-only (an admin can still unlock and
            re-close to make corrections).
          </p>
        </div>
        <div className="px-6 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
          <button onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 rounded-lg border border-gray-200 text-gray-600 font-mono text-base font-bold hover:bg-gray-50 disabled:opacity-50">
            NO
          </button>
          <button onClick={onConfirm}
            disabled={busy}
            className="px-5 py-2 rounded-lg bg-red-600 text-white font-mono text-base font-bold hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed">
            {busy ? 'CLOSING…' : 'YES, CLOSE SHIFT'}
          </button>
        </div>
      </div>
    </div>
  );
}
