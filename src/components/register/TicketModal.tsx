// TicketModal — TurnEm checkout ticket pane.
//
// Shows the full ticket: header (client, ticket number, primary staff),
// editable line-items grid (Qty, Service, Staff, Price, Discount, Ext. Price),
// per-ticket discount + tip + tax, payment buttons (Cash, Credit Card, Gift),
// totals column.
//
// Footer actions (open ticket): Cust History, Book Appt, Void, Process.
// Per-line trash icon removes a single line.
//
// Modes:
//   - status='open'   → editable; Process button captures payment(s)
//                       and flips status to 'closed'
//   - status='closed' → read-only view; payments shown
//   - status='voided' → read-only with VOID banner
//
// Money is integer cents end-to-end. Free-text dollar inputs are coerced via
// parseDollarsToCents on blur.

import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import {
  computeLineExt,
  formatMoneyCents,
  parseDollarsToCents,
  updateOpenTicket,
  closeTicket,
  voidTicket,
  type ClosingPaymentInput,
} from '../../lib/tickets';
import { fetchOpenShift } from '../../lib/shifts';
import GiftCardSaleModal from './GiftCardSaleModal';
import type { PaymentMethod, Ticket } from '../../types';

interface Props {
  ticket: Ticket;
  onClose: () => void;
  onChanged?: (saved: Ticket) => void;
  /** Open the customer-history view for the current client phone. */
  onShowCustomerHistory?: (clientPhone: string, clientName: string) => void;
  /** Open the appointment booking flow for the current client. */
  onBookAppointment?: (clientPhone: string, clientName: string) => void;
}

interface DraftLine {
  existingId?: string;
  serviceId: string | null;
  name: string;
  staff1Id: string | null;
  staff1Name: string;
  staff1Color: string;
  staff2Id: string | null;
  staff2Name: string;
  staff2Color: string;
  priceInput: string;       // free-text dollar input
  discountInput: string;    // free-text dollar input (discount per line)
  quantity: number;
  kind: 'service' | 'retail' | 'discount' | 'gift_card_sale';
}

interface PendingPayment {
  method: PaymentMethod;
  amountInput: string;       // free-text dollar input
  tenderedInput?: string;    // cash only
  giftCardCode?: string;     // gift only
}

export default function TicketModal({
  ticket,
  onClose,
  onChanged,
  onShowCustomerHistory,
  onBookAppointment,
}: Props) {
  const { state } = useApp();
  const isOpen = ticket.status === 'open';
  const isVoided = ticket.status === 'voided';

  // ─── Header state ─────────────────────────────────────────────────────────
  const [clientName, setClientName] = useState(ticket.clientName);
  const [clientPhone, setClientPhone] = useState(ticket.clientPhone);
  const [primaryManicuristId, setPrimaryManicuristId] = useState<string | null>(
    ticket.primaryManicuristId,
  );
  const [note, setNote] = useState(ticket.note);

  // ─── Line items ───────────────────────────────────────────────────────────
  const [lines, setLines] = useState<DraftLine[]>(() =>
    ticket.items.map((it) => ({
      existingId: it.id,
      serviceId: it.serviceId,
      name: it.name,
      staff1Id: it.staff1Id,
      staff1Name: it.staff1Name,
      staff1Color: it.staff1Color,
      staff2Id: it.staff2Id,
      staff2Name: it.staff2Name,
      staff2Color: it.staff2Color,
      priceInput: (it.unitPriceCents / 100).toFixed(2),
      discountInput: (it.discountCents / 100).toFixed(2),
      quantity: it.quantity,
      kind: it.kind,
    })),
  );

  // ─── Ticket-level totals state ────────────────────────────────────────────
  const [ticketDiscountInput, setTicketDiscountInput] = useState((ticket.discountCents / 100).toFixed(2));
  const [taxInput, setTaxInput] = useState((ticket.taxCents / 100).toFixed(2));
  const [tipInput, setTipInput] = useState((ticket.tipCents / 100).toFixed(2));

  // ─── Payments scratchpad (for processing on close) ────────────────────────
  const [pending, setPending] = useState<PendingPayment[]>([]);

  // ─── Derived totals ───────────────────────────────────────────────────────
  const subtotalCents = useMemo(
    () =>
      lines.reduce(
        (s, l) =>
          s +
          computeLineExt({
            unitPriceCents: parseDollarsToCents(l.priceInput),
            quantity: l.quantity,
            discountCents: parseDollarsToCents(l.discountInput),
          }),
        0,
      ),
    [lines],
  );
  const ticketDiscountCents = parseDollarsToCents(ticketDiscountInput);
  const taxCents = parseDollarsToCents(taxInput);
  const tipCents = parseDollarsToCents(tipInput);
  const totalCents = Math.max(0, subtotalCents - ticketDiscountCents + taxCents + tipCents);
  const pendingPaidCents = pending.reduce((s, p) => s + parseDollarsToCents(p.amountInput), 0);
  const dueCents = totalCents - (isOpen ? pendingPaidCents : ticket.paidCents);

  // ─── Helpers ──────────────────────────────────────────────────────────────
  const sortedServices = useMemo(
    () =>
      [...state.salonServices]
        .filter((s) => s.isActive)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [state.salonServices],
  );
  const manicurists = useMemo(
    () => [...state.manicurists].sort((a, b) => a.name.localeCompare(b.name)),
    [state.manicurists],
  );
  function manicuristById(id: string | null) {
    return id ? state.manicurists.find((m) => m.id === id) ?? null : null;
  }

  function updateLine(idx: number, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }
  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }
  function addCatalogService(svcId: string) {
    const svc = sortedServices.find((s) => s.id === svcId);
    if (!svc) return;
    const m = manicuristById(primaryManicuristId);
    setLines((prev) => [
      ...prev,
      {
        serviceId: svc.id,
        name: svc.name,
        staff1Id: m?.id ?? null,
        staff1Name: m?.name ?? '',
        staff1Color: m?.color ?? '#9ca3af',
        staff2Id: null,
        staff2Name: '',
        staff2Color: '#9ca3af',
        priceInput: svc.price.toFixed(2),
        discountInput: '0.00',
        quantity: 1,
        kind: 'service',
      },
    ]);
  }

  function addBlankCustomLine() {
    setLines((prev) => [
      ...prev,
      {
        serviceId: null,
        name: '',
        staff1Id: null,
        staff1Name: '',
        staff1Color: '#9ca3af',
        staff2Id: null,
        staff2Name: '',
        staff2Color: '#9ca3af',
        priceInput: '0.00',
        discountInput: '0.00',
        quantity: 1,
        kind: 'service',
      },
    ]);
  }

  /**
   * Add a gift-card-sale line for the given serial, value (cents), and the
   * staff member who sold it (credited via staff1 so it shows up in the
   * cashier's daily sales / commission report).
   */
  function addGiftLine(
    serial: string,
    valueCents: number,
    staff: { id: string | null; name: string; color: string },
  ) {
    setLines((prev) => [
      ...prev,
      {
        serviceId: null,
        name: `Gift Certificate #${serial}`,
        staff1Id: staff.id,
        staff1Name: staff.name,
        staff1Color: staff.color,
        staff2Id: null,
        staff2Name: '',
        staff2Color: '#9ca3af',
        priceInput: (valueCents / 100).toFixed(2),
        discountInput: '0.00',
        quantity: 1,
        kind: 'gift_card_sale',
      },
    ]);
  }

  // Whether the gift-card-sale modal is open.
  const [showGiftModal, setShowGiftModal] = useState(false);

  // ─── Pending payment edits ────────────────────────────────────────────────
  function addPending(method: PaymentMethod) {
    setPending((prev) => {
      // Default amount = remaining due (rounded to dollars).
      const remaining = Math.max(0, totalCents - prev.reduce((s, p) => s + parseDollarsToCents(p.amountInput), 0));
      const def = (remaining / 100).toFixed(2);
      const row: PendingPayment = { method, amountInput: def };
      if (method === 'cash') row.tenderedInput = def;
      if (method === 'gift') row.giftCardCode = '';
      return [...prev, row];
    });
  }
  function removePending(idx: number) {
    setPending((prev) => prev.filter((_, i) => i !== idx));
  }
  function patchPending(idx: number, patch: Partial<PendingPayment>) {
    setPending((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }

  // ─── Save (without closing) ───────────────────────────────────────────────
  const [busy, setBusy] = useState<'idle' | 'saving' | 'processing' | 'voiding'>('idle');
  const [error, setError] = useState<string | null>(null);

  function buildItemsForSave() {
    return lines.map((l) => ({
      id: l.existingId,
      kind: l.kind,
      name: l.name.trim(),
      serviceId: l.serviceId,
      staff1Id: l.staff1Id,
      staff1Name: l.staff1Name,
      staff1Color: l.staff1Color,
      staff2Id: l.staff2Id,
      staff2Name: l.staff2Name,
      staff2Color: l.staff2Color,
      unitPriceCents: parseDollarsToCents(l.priceInput),
      quantity: l.quantity,
      discountCents: parseDollarsToCents(l.discountInput),
    }));
  }

  async function doSave(): Promise<Ticket | null> {
    setError(null);
    if (lines.some((l) => !l.name.trim())) {
      setError('Every line needs a name.');
      return null;
    }
    setBusy('saving');
    const m = manicuristById(primaryManicuristId);
    const saved = await updateOpenTicket({
      ticketId: ticket.id,
      clientName,
      clientPhone,
      primaryManicuristId,
      primaryManicuristName: m?.name ?? '',
      primaryManicuristColor: m?.color ?? '#9ca3af',
      note,
      ticketDiscountCents,
      taxCents,
      tipCents,
      items: buildItemsForSave(),
    });
    setBusy('idle');
    if (!saved) {
      setError('Could not save — check connection and try again.');
      return null;
    }
    onChanged?.(saved);
    return saved;
  }

  // ─── Process Ticket ───────────────────────────────────────────────────────
  async function handleProcess() {
    setError(null);
    if (lines.length === 0) { setError('Add at least one item.'); return; }
    if (pending.length === 0) { setError('Add a payment first.'); return; }
    if (Math.abs(pendingPaidCents - totalCents) > 0) {
      setError(`Payments ${formatMoneyCents(pendingPaidCents)} ≠ total ${formatMoneyCents(totalCents)}.`);
      return;
    }
    // Save edits first so payment is captured against current totals.
    const saved = await doSave();
    if (!saved) return;

    setBusy('processing');
    const shift = await fetchOpenShift();
    if (!shift) {
      setError('No shift is open. Open a shift before processing tickets.');
      setBusy('idle');
      return;
    }
    const closingPayments: ClosingPaymentInput[] = pending.map((p) => {
      const amt = parseDollarsToCents(p.amountInput);
      const tendered = p.tenderedInput ? parseDollarsToCents(p.tenderedInput) : undefined;
      return {
        method: p.method,
        amountCents: amt,
        tenderedCents: tendered,
        changeCents: tendered !== undefined && tendered > amt ? tendered - amt : 0,
        giftCardCode: p.giftCardCode,
      };
    });
    const closed = await closeTicket({
      ticketId: ticket.id,
      shiftId: shift.id,
      payments: closingPayments,
    });
    setBusy('idle');
    if (!closed) {
      setError('Could not process ticket — try again.');
      return;
    }
    onChanged?.(closed);
    onClose();
  }

  // ─── Void ─────────────────────────────────────────────────────────────────
  async function handleVoid() {
    if (!confirm('Void this ticket? This cannot be undone.')) return;
    const reason = prompt('Reason for voiding (optional):') ?? '';
    setBusy('voiding');
    const ok = await voidTicket(ticket.id, reason);
    setBusy('idle');
    if (ok) onClose();
  }

  // Esc to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col animate-modal-in">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-baseline gap-4">
            <h2 className="font-bebas text-2xl tracking-widest text-gray-900">TICKET</h2>
            <span className="font-mono text-sm text-gray-400">#{ticket.ticketNumber}</span>
            <span className="font-mono text-sm text-gray-400">{ticket.businessDate}</span>
            {ticket.status === 'closed' && (
              <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-mono text-sm font-bold tracking-wider">CLOSED</span>
            )}
            {isVoided && (
              <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-mono text-sm font-bold tracking-wider">VOID</span>
            )}
            {isOpen && (
              <span className="px-2 py-0.5 rounded-full bg-pink-100 text-pink-600 font-mono text-sm font-bold tracking-wider">OPEN</span>
            )}
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        {/* Body — two column on lg, single column on sm */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6">
            {/* Left column — header + items */}
            <div className="flex flex-col gap-4">
              {/* Client + manicurist */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="font-mono text-sm tracking-wider font-semibold text-gray-400 uppercase">Client</label>
                  <input
                    type="text" value={clientName} onChange={(e) => setClientName(e.target.value)}
                    disabled={!isOpen}
                    className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 font-mono text-sm focus:outline-none focus:border-gray-400 disabled:bg-gray-50 disabled:text-gray-500"
                    placeholder="Walk-in"
                  />
                </div>
                <div>
                  <label className="font-mono text-sm tracking-wider font-semibold text-gray-400 uppercase">Phone</label>
                  <input
                    type="tel" value={clientPhone} onChange={(e) => setClientPhone(e.target.value)}
                    disabled={!isOpen}
                    className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 font-mono text-sm focus:outline-none focus:border-gray-400 disabled:bg-gray-50 disabled:text-gray-500"
                    placeholder="(555) 555-5555"
                  />
                </div>
                <div>
                  <label className="font-mono text-sm tracking-wider font-semibold text-gray-400 uppercase">Primary Staff</label>
                  <select
                    value={primaryManicuristId ?? ''}
                    onChange={(e) => setPrimaryManicuristId(e.target.value || null)}
                    disabled={!isOpen}
                    className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 font-mono text-sm focus:outline-none focus:border-gray-400 disabled:bg-gray-50 disabled:text-gray-500"
                  >
                    <option value="">—</option>
                    {manicurists.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Line items grid */}
              <div className="border border-gray-100 rounded-xl overflow-hidden">
                <div className="grid grid-cols-[60px_1fr_140px_100px_100px_100px_36px] gap-2 px-3 py-2 bg-gray-50 border-b border-gray-100 text-sm tracking-wider font-mono font-semibold text-gray-400 uppercase">
                  <span className="text-center">Qty</span>
                  <span>Service</span>
                  <span>Staff</span>
                  <span className="text-right">Price</span>
                  <span className="text-right">Disc</span>
                  <span className="text-right">Ext</span>
                  <span></span>
                </div>
                {lines.length === 0 ? (
                  <div className="px-3 py-6 text-center font-mono text-sm text-gray-400">
                    No line items yet.
                  </div>
                ) : (
                  lines.map((line, idx) => {
                    const ext = computeLineExt({
                      unitPriceCents: parseDollarsToCents(line.priceInput),
                      quantity: line.quantity,
                      discountCents: parseDollarsToCents(line.discountInput),
                    });
                    return (
                      <div
                        key={idx}
                        className="grid grid-cols-[60px_1fr_140px_100px_100px_100px_36px] gap-2 items-center px-3 py-2 border-b border-gray-50 last:border-b-0"
                      >
                        <input
                          type="number" min={1} step={1} value={line.quantity}
                          onChange={(e) => updateLine(idx, { quantity: Math.max(1, parseInt(e.target.value || '1', 10)) })}
                          disabled={!isOpen}
                          className="px-2 py-1.5 rounded-md border border-transparent hover:border-gray-200 focus:border-gray-400 font-mono text-sm text-center focus:outline-none disabled:bg-gray-50"
                        />
                        <input
                          type="text" value={line.name}
                          onChange={(e) => updateLine(idx, { name: e.target.value })}
                          disabled={!isOpen}
                          placeholder="Service name"
                          className="px-2 py-1.5 rounded-md border border-transparent hover:border-gray-200 focus:border-gray-400 font-mono text-sm focus:outline-none disabled:bg-gray-50"
                        />
                        <select
                          value={line.staff1Id ?? ''}
                          onChange={(e) => {
                            const m = manicuristById(e.target.value || null);
                            updateLine(idx, {
                              staff1Id: m?.id ?? null,
                              staff1Name: m?.name ?? '',
                              staff1Color: m?.color ?? '#9ca3af',
                            });
                          }}
                          disabled={!isOpen}
                          className="px-2 py-1.5 rounded-md border border-transparent hover:border-gray-200 focus:border-gray-400 font-mono text-sm focus:outline-none disabled:bg-gray-50"
                        >
                          <option value="">—</option>
                          {manicurists.map((m) => (
                            <option key={m.id} value={m.id}>{m.name}</option>
                          ))}
                        </select>
                        <input
                          type="text" inputMode="decimal" value={line.priceInput}
                          onChange={(e) => updateLine(idx, { priceInput: e.target.value })}
                          onBlur={(e) => updateLine(idx, { priceInput: (parseDollarsToCents(e.target.value) / 100).toFixed(2) })}
                          disabled={!isOpen}
                          className="px-2 py-1.5 rounded-md border border-transparent hover:border-gray-200 focus:border-gray-400 font-mono text-sm text-right focus:outline-none disabled:bg-gray-50"
                        />
                        <input
                          type="text" inputMode="decimal" value={line.discountInput}
                          onChange={(e) => updateLine(idx, { discountInput: e.target.value })}
                          onBlur={(e) => updateLine(idx, { discountInput: (parseDollarsToCents(e.target.value) / 100).toFixed(2) })}
                          disabled={!isOpen}
                          className="px-2 py-1.5 rounded-md border border-transparent hover:border-gray-200 focus:border-gray-400 font-mono text-sm text-right focus:outline-none disabled:bg-gray-50"
                        />
                        <span className="px-2 py-1.5 font-mono text-sm font-semibold text-gray-900 text-right">
                          {formatMoneyCents(ext)}
                        </span>
                        {isOpen ? (
                          <button onClick={() => removeLine(idx)}
                            className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors">
                            <Trash2 size={14} />
                          </button>
                        ) : <span />}
                      </div>
                    );
                  })
                )}

                {/* Add line */}
                {isOpen && (
                  <div className="grid grid-cols-[1fr_auto_auto] gap-2 items-center px-3 py-2.5 bg-gray-50/60 border-t border-gray-100">
                    <select
                      value="" onChange={(e) => e.target.value && addCatalogService(e.target.value)}
                      className="px-2 py-1.5 rounded-md border border-gray-200 font-mono text-sm bg-white focus:outline-none focus:border-gray-400"
                    >
                      <option value="">+ Add service from menu…</option>
                      {sortedServices.map((s) => (
                        <option key={s.id} value={s.id}>{s.name} — ${s.price.toFixed(2)}</option>
                      ))}
                    </select>
                    <button onClick={addBlankCustomLine}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-white font-mono text-sm font-semibold transition-colors">
                      <Plus size={14} /> CUSTOM
                    </button>
                    <button onClick={() => setShowGiftModal(true)}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-pink-200 bg-pink-50 text-pink-700 hover:bg-pink-100 hover:border-pink-300 font-mono text-sm font-semibold transition-colors">
                      <Plus size={14} /> GIFT
                    </button>
                  </div>
                )}
              </div>

              {/* Note */}
              <div>
                <label className="font-mono text-sm tracking-wider font-semibold text-gray-400 uppercase">Note</label>
                <textarea
                  value={note} onChange={(e) => setNote(e.target.value)}
                  disabled={!isOpen} rows={2}
                  className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 font-mono text-sm focus:outline-none focus:border-gray-400 resize-none disabled:bg-gray-50"
                  placeholder="e.g. redeemed gift card #1234"
                />
              </div>
            </div>

            {/* Right column — totals + payments */}
            <div className="flex flex-col gap-3">
              <div className="bg-gray-50 rounded-xl p-4 flex flex-col gap-2">
                <Row label="Subtotal" value={formatMoneyCents(subtotalCents)} />
                <RowEdit label="Discount" value={ticketDiscountInput}
                  onChange={(v) => setTicketDiscountInput(v)}
                  onBlur={(v) => setTicketDiscountInput((parseDollarsToCents(v) / 100).toFixed(2))}
                  disabled={!isOpen} />
                <RowEdit label="Tax" value={taxInput}
                  onChange={(v) => setTaxInput(v)}
                  onBlur={(v) => setTaxInput((parseDollarsToCents(v) / 100).toFixed(2))}
                  disabled={!isOpen} />
                <RowEdit label="Tip" value={tipInput}
                  onChange={(v) => setTipInput(v)}
                  onBlur={(v) => setTipInput((parseDollarsToCents(v) / 100).toFixed(2))}
                  disabled={!isOpen} />
                <div className="border-t border-gray-200 my-1" />
                <Row label="Total" value={formatMoneyCents(totalCents)} bold />
                <Row
                  label="Payments"
                  value={formatMoneyCents(isOpen ? pendingPaidCents : ticket.paidCents)}
                />
                <Row
                  label="Due"
                  value={formatMoneyCents(dueCents)}
                  bold
                  highlight={isOpen && dueCents !== 0}
                />
              </div>

              {/* Payments — open ticket lets you queue tenders; closed shows captured */}
              {isOpen ? (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <PayBtn label="Cash" tone="cash" onClick={() => addPending('cash')} />
                    <PayBtn label="Credit Card" tone="card" onClick={() => addPending('visa_mc')} />
                    <PayBtn label="Gift" tone="gift" onClick={() => addPending('gift')} />
                  </div>
                  {pending.length > 0 && (
                    <div className="border border-gray-100 rounded-xl divide-y divide-gray-50">
                      {pending.map((p, idx) => (
                        <div key={idx} className="px-3 py-2 flex items-center gap-2">
                          <span className="font-mono text-sm font-bold text-gray-500 w-20">
                            {p.method === 'visa_mc' ? 'CREDIT CARD' : p.method.toUpperCase()}
                          </span>
                          <span className="font-mono text-sm text-gray-400">$</span>
                          <input
                            type="text" inputMode="decimal" value={p.amountInput}
                            onChange={(e) => patchPending(idx, { amountInput: e.target.value })}
                            onBlur={(e) => patchPending(idx, { amountInput: (parseDollarsToCents(e.target.value) / 100).toFixed(2) })}
                            className="flex-1 px-2 py-1 rounded-md border border-gray-200 font-mono text-sm text-right focus:outline-none focus:border-gray-400"
                          />
                          <button onClick={() => removePending(idx)}
                            className="p-1 rounded-md text-gray-300 hover:text-red-500 hover:bg-red-50">
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                      {pending.some((p) => p.method === 'cash') && (
                        <div className="px-3 py-2">
                          <label className="font-mono text-sm tracking-wider text-gray-400 uppercase">Tendered (cash)</label>
                          {pending.map((p, idx) =>
                            p.method !== 'cash' ? null : (
                              <input
                                key={idx} type="text" inputMode="decimal"
                                value={p.tenderedInput ?? ''}
                                onChange={(e) => patchPending(idx, { tenderedInput: e.target.value })}
                                onBlur={(e) => patchPending(idx, { tenderedInput: (parseDollarsToCents(e.target.value) / 100).toFixed(2) })}
                                className="mt-1 w-full px-2 py-1 rounded-md border border-gray-200 font-mono text-sm text-right focus:outline-none focus:border-gray-400"
                                placeholder="0.00"
                              />
                            ),
                          )}
                        </div>
                      )}
                      {pending.some((p) => p.method === 'gift') && (
                        <div className="px-3 py-2">
                          <label className="font-mono text-sm tracking-wider text-gray-400 uppercase">Gift card code</label>
                          {pending.map((p, idx) =>
                            p.method !== 'gift' ? null : (
                              <input
                                key={idx} type="text"
                                value={p.giftCardCode ?? ''}
                                onChange={(e) => patchPending(idx, { giftCardCode: e.target.value })}
                                className="mt-1 w-full px-2 py-1 rounded-md border border-gray-200 font-mono text-sm focus:outline-none focus:border-gray-400"
                                placeholder="GC-####"
                              />
                            ),
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className="border border-gray-100 rounded-xl divide-y divide-gray-50">
                  {ticket.payments.length === 0 ? (
                    <div className="px-3 py-3 font-mono text-sm text-gray-400 text-center">No payments captured.</div>
                  ) : (
                    ticket.payments.map((p) => (
                      <div key={p.id} className="px-3 py-2 flex items-center justify-between">
                        <span className="font-mono text-sm font-bold text-gray-500">
                          {p.method === 'visa_mc' ? 'CREDIT CARD' : p.method.toUpperCase()}
                        </span>
                        <span className="font-mono text-sm text-gray-900">{formatMoneyCents(p.amountCents)}</span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer — simplified action row.
            Open ticket: [Discounts] [Delete Line] [Cust History] [Book Appt] | [Void] [Process]
            Closed/voided ticket: [Cust History] [Book Appt] | [Close] */}
        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between gap-3 flex-wrap">
          {error && <p className="font-mono text-sm text-red-500 w-full sm:w-auto">{error}</p>}
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            <FooterBtn
              label="CUST HISTORY"
              onClick={() => onShowCustomerHistory?.(clientPhone, clientName)}
              disabled={!onShowCustomerHistory || busy !== 'idle'}
            />
            <FooterBtn
              label="BOOK APPT"
              onClick={() => onBookAppointment?.(clientPhone, clientName)}
              disabled={!onBookAppointment || busy !== 'idle'}
            />
            {isOpen && (
              <>
                <span className="w-px h-6 bg-gray-200 mx-1" />
                <button onClick={handleVoid} disabled={busy !== 'idle'}
                  className="px-3 py-2 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 font-mono text-xs font-bold disabled:opacity-50">
                  {busy === 'voiding' ? 'VOIDING…' : 'VOID'}
                </button>
                <button onClick={handleProcess} disabled={busy !== 'idle'}
                  className="px-4 py-2 rounded-lg bg-gray-900 text-white font-mono text-xs font-bold hover:bg-gray-800 disabled:opacity-50">
                  {busy === 'processing' ? 'PROCESSING…' : 'PROCESS'}
                </button>
              </>
            )}
            {!isOpen && (
              <button onClick={onClose}
                className="px-4 py-2 rounded-lg bg-gray-900 text-white font-mono text-xs font-bold hover:bg-gray-800">
                CLOSE
              </button>
            )}
          </div>
        </div>
      </div>
      {showGiftModal && (
        <GiftCardSaleModal
          onClose={() => setShowGiftModal(false)}
          onAdd={(serial, valueCents, staff) => addGiftLine(serial, valueCents, staff)}
        />
      )}
    </div>
  );
}

// ── small row primitives for the totals column ────────────────────────────

function Row({ label, value, bold, highlight }: { label: string; value: string; bold?: boolean; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={`font-mono text-sm ${bold ? 'font-bold text-gray-900' : 'text-gray-500'}`}>{label}</span>
      <span className={`font-mono text-sm ${bold ? 'font-bold' : ''} ${highlight ? 'text-pink-600' : 'text-gray-900'}`}>{value}</span>
    </div>
  );
}

function RowEdit({
  label, value, onChange, onBlur, disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="font-mono text-sm text-gray-500">{label}</span>
      <div className="flex items-center gap-1">
        <span className="font-mono text-sm text-gray-400">$</span>
        <input
          type="text" inputMode="decimal" value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => onBlur(e.target.value)}
          disabled={disabled}
          className="w-20 px-2 py-1 rounded-md border border-transparent hover:border-gray-200 focus:border-gray-400 font-mono text-sm text-right focus:outline-none disabled:bg-transparent bg-white"
        />
      </div>
    </div>
  );
}

function PayBtn({
  label,
  onClick,
  tone = 'neutral',
}: {
  label: string;
  onClick: () => void;
  tone?: 'cash' | 'card' | 'gift' | 'neutral';
}) {
  const toneClasses =
    tone === 'cash'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:border-emerald-300'
      : tone === 'card'
      ? 'border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100 hover:border-sky-300'
      : tone === 'gift'
      ? 'border-pink-200 bg-pink-50 text-pink-700 hover:bg-pink-100 hover:border-pink-300'
      : 'border-gray-200 text-gray-700 hover:bg-gray-50 hover:border-gray-300';
  return (
    <button
      onClick={onClick}
      className={`px-3 py-2.5 rounded-lg border ${toneClasses} font-bebas text-base tracking-widest transition-colors`}
    >
      {label}
    </button>
  );
}

function FooterBtn({
  label,
  onClick,
  disabled,
  tone = 'neutral',
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'neutral' | 'danger';
}) {
  const toneClasses =
    tone === 'danger'
      ? 'border-red-200 text-red-500 hover:bg-red-50'
      : 'border-gray-200 text-gray-700 hover:bg-gray-50';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-2 rounded-lg border ${toneClasses} font-mono text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed transition-colors`}
    >
      {label}
    </button>
  );
}
