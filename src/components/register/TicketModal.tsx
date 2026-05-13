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
  reallocateTurnsForStaffChanges,
  type ClosingPaymentInput,
} from '../../lib/tickets';
import { fetchOpenShift } from '../../lib/shifts';
import GiftCardSaleModal from './GiftCardSaleModal';
import ReceptionistPinGate from '../shared/ReceptionistPinGate';
import { SERVICE_CATEGORIES } from '../../constants/services';
import type { PaymentMethod, Ticket } from '../../types';

interface Props {
  ticket: Ticket;
  onClose: () => void;
  onChanged?: (saved: Ticket) => void;
  /** Open the customer-history view for the current client phone. */
  /** Open the appointment booking flow for the current client. */
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
}: Props) {
  const { state, dispatch } = useApp();
  // History panel state — opens a side modal showing this customer's
  // past tickets. Wired by the HISTORY footer button.
  const [showHistory, setShowHistory] = useState(false);
  const isOpen = ticket.status === 'open';
  const isVoided = ticket.status === 'voided';
  // VOID requires a receptionist PIN — the modal renders inline once this is true.
  const [showVoidGate, setShowVoidGate] = useState(false);

  // ─── Header state ─────────────────────────────────────────────────────────
  // Split the stored single-string client name into first/last on first render.
  // We persist it back as `${first} ${last}`.trim() so the data layer is unchanged.
  const [clientFirstName, setClientFirstName] = useState(() => {
    const idx = ticket.clientName.indexOf(' ');
    return idx === -1 ? ticket.clientName : ticket.clientName.slice(0, idx);
  });
  const [clientLastName, setClientLastName] = useState(() => {
    const idx = ticket.clientName.indexOf(' ');
    return idx === -1 ? '' : ticket.clientName.slice(idx + 1);
  });
  const clientName = `${clientFirstName.trim()} ${clientLastName.trim()}`.trim();
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
  // Snapshot of the original (staff1Id, queueEntryId) per line, captured
  // once on mount. We diff this against the current `lines` state on Save
  // to know which manicurist reassignments to push through the turn-credit
  // reallocation path.
  const originalStaffByItemId = useMemo(() => {
    const m = new Map<string, { staff1Id: string | null; queueEntryId: string | null }>();
    for (const it of ticket.items) {
      m.set(it.id, { staff1Id: it.staff1Id, queueEntryId: it.queueEntryId ?? null });
    }
    return m;
  }, [ticket.items]);

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
  // Category → Service picker state, mirroring the queue Add Client form
  // so receptionists land on the same two-step flow whether they're
  // checking in or checking out.
  const [pickerCategory, setPickerCategory] = useState('');
  const [pickerServiceId, setPickerServiceId] = useState('');
  const availableCategories = useMemo(() => {
    const set = new Set(sortedServices.map((s) => s.category).filter(Boolean));
    return SERVICE_CATEGORIES.filter((c) => set.has(c));
  }, [sortedServices]);
  const servicesInCategory = useMemo(() => {
    if (!pickerCategory) return [];
    return sortedServices.filter((s) => s.category === pickerCategory);
  }, [sortedServices, pickerCategory]);
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

  // True if any discount (line-level OR ticket-level) is currently applied.
  const hasAnyDiscount =
    ticketDiscountCents > 0 ||
    lines.some((l) => parseDollarsToCents(l.discountInput) > 0);

  async function doSave(): Promise<Ticket | null> {
    setError(null);
    if (lines.some((l) => !l.name.trim())) {
      setError('Every line needs a name.');
      return null;
    }
    if (hasAnyDiscount && !note.trim()) {
      setError('A note is required when a discount is applied. Add a note explaining the discount.');
      setShowNote(true);
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
    // Turn reallocation: any line whose staff1 changed reassigns the turn
    // credit from the old assignee to the new one. Only service-kind lines
    // with a queue_entry_id (i.e. ones tied to a completed entry) qualify;
    // manually-added lines never had a turn credited to begin with.
    const changes: Array<{
      queueEntryId: string;
      oldStaffId: string | null;
      newStaffId: string | null;
      newStaffName: string;
      newStaffColor: string;
    }> = [];
    for (const l of lines) {
      if (l.kind !== 'service' || !l.existingId) continue;
      const orig = originalStaffByItemId.get(l.existingId);
      if (!orig || !orig.queueEntryId) continue;
      if (orig.staff1Id === l.staff1Id) continue;
      changes.push({
        queueEntryId: orig.queueEntryId,
        oldStaffId: orig.staff1Id,
        newStaffId: l.staff1Id,
        newStaffName: l.staff1Name,
        newStaffColor: l.staff1Color,
      });
    }
    if (changes.length > 0) {
      void reallocateTurnsForStaffChanges(changes);
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
  // The button just flips the gate flag open. The PIN gate captures the
  // receptionist + reason and calls handleVoidConfirmed below; we never
  // hit the DB until the PIN matches a real receptionist.
  function handleVoid() {
    setShowVoidGate(true);
  }
  async function handleVoidConfirmed(receptionistId: string, reason: string) {
    setShowVoidGate(false);
    setBusy('voiding');
    const ok = await voidTicket(ticket.id, reason, receptionistId);
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

  // Show the note inline only when there's content (or when the user explicitly
  // expands it). Keeps the default view compact so the whole ticket fits without
  // scrolling.
  const [showNote, setShowNote] = useState(() => Boolean(ticket.note));

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-3">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl max-h-[96vh] flex flex-col animate-modal-in">
        {/* Header */}
        <div className="px-5 py-2.5 border-b border-gray-100 flex items-center justify-between">
          <div className="flex items-baseline gap-3">
            <h2 className="font-bebas text-2xl tracking-widest text-gray-900">CHECK OUT TICKET</h2>
            <span className="font-mono text-xs text-gray-400">#{ticket.ticketNumber}</span>
            <span className="font-mono text-xs text-gray-400">{formatBusinessDate(ticket.businessDate)}</span>
            {ticket.status === 'closed' && (
              <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-mono text-xs font-bold tracking-wider">CLOSED</span>
            )}
            {isVoided && (
              <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-mono text-xs font-bold tracking-wider">VOID</span>
            )}
            {isOpen && (
              <span className="px-2 py-0.5 rounded-full bg-pink-100 text-pink-600 font-mono text-xs font-bold tracking-wider">OPEN</span>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        {/* Body — two column on lg, single column on sm.
            min-h-0 + the inner column's overflow rule lets only the line items
            scroll if there are a lot of them, keeping totals/payments visible. */}
        <div className="flex-1 min-h-0 px-5 py-3">
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-4 h-full">
            {/* Left column — header + items */}
            <div className="flex flex-col gap-2 min-h-0">
              {/* Client + manicurist — compact single row */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Field label="First Name">
                  <input
                    type="text" value={clientFirstName} onChange={(e) => setClientFirstName(e.target.value)}
                    disabled={!isOpen}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-gray-200 font-mono text-sm focus:outline-none focus:border-gray-400 disabled:bg-gray-50 disabled:text-gray-500"
                    placeholder="Walk-in"
                  />
                </Field>
                <Field label="Last Name">
                  <input
                    type="text" value={clientLastName} onChange={(e) => setClientLastName(e.target.value)}
                    disabled={!isOpen}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-gray-200 font-mono text-sm focus:outline-none focus:border-gray-400 disabled:bg-gray-50 disabled:text-gray-500"
                    placeholder="—"
                  />
                </Field>
                <Field label="Phone">
                  <input
                    type="tel" value={clientPhone} onChange={(e) => setClientPhone(e.target.value)}
                    disabled={!isOpen}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-gray-200 font-mono text-sm focus:outline-none focus:border-gray-400 disabled:bg-gray-50 disabled:text-gray-500"
                    placeholder="(555) 555-5555"
                  />
                </Field>
                <Field label="Primary Staff">
                  <select
                    value={primaryManicuristId ?? ''}
                    onChange={(e) => setPrimaryManicuristId(e.target.value || null)}
                    disabled={!isOpen}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-gray-200 font-mono text-sm focus:outline-none focus:border-gray-400 disabled:bg-gray-50 disabled:text-gray-500"
                  >
                    <option value="">—</option>
                    {manicurists.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </Field>
              </div>

              {/* Line items grid — scrolls inside if needed so the rest stays in view */}
              <div className="border border-gray-100 rounded-xl overflow-hidden flex flex-col min-h-0">
                <div className="grid grid-cols-[46px_60px_1fr_130px_90px_90px_90px_30px] gap-2 px-3 py-1.5 bg-gray-50 border-b border-gray-100 text-[11px] tracking-wider font-mono font-semibold text-gray-400 uppercase">
                  <span className="text-center">#</span>
                  <span className="text-center">Qty</span>
                  <span>Service</span>
                  <span>Staff</span>
                  <span className="text-right">Price</span>
                  <span className="text-right">Disc</span>
                  <span className="text-right">Ext</span>
                  <span></span>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto">
                  {lines.length === 0 ? (
                    <div className="px-3 py-4 text-center font-mono text-xs text-gray-400">
                      No line items yet.
                    </div>
                  ) : (
                    (() => {
                      // Sequential service-only counter for the left-edge
                      // red-circle badge. Retail / discount / gift_card_sale
                      // lines don't get numbered — only manicurist work counts.
                      let svcN = 0;
                      return lines.map((line, idx) => {
                      const ext = computeLineExt({
                        unitPriceCents: parseDollarsToCents(line.priceInput),
                        quantity: line.quantity,
                        discountCents: parseDollarsToCents(line.discountInput),
                      });
                      const isService = line.kind === 'service';
                      if (isService) svcN += 1;
                      const badgeNumber = isService ? svcN : null;
                      return (
                        <div
                          key={idx}
                          className="grid grid-cols-[46px_60px_1fr_130px_90px_90px_90px_30px] gap-2 items-center px-3 py-1 border-b border-gray-50 last:border-b-0"
                        >
                          {badgeNumber !== null ? (
                            <span className="justify-self-center w-7 h-7 rounded-full border-2 border-red-500 text-red-600 font-mono text-base font-bold flex items-center justify-center">
                              {badgeNumber}
                            </span>
                          ) : (
                            <span />
                          )}
                          <input
                            type="number" min={1} step={1} value={line.quantity}
                            onChange={(e) => updateLine(idx, { quantity: Math.max(1, parseInt(e.target.value || '1', 10)) })}
                            disabled={!isOpen}
                            className="px-1.5 py-1 rounded-md border border-transparent hover:border-gray-200 focus:border-gray-400 font-mono text-sm text-center focus:outline-none disabled:bg-gray-50"
                          />
                          <input
                            type="text" value={line.name}
                            onChange={(e) => updateLine(idx, { name: e.target.value })}
                            disabled={!isOpen}
                            placeholder="Service name"
                            className="px-1.5 py-1 rounded-md border border-transparent hover:border-gray-200 focus:border-gray-400 font-mono text-sm focus:outline-none disabled:bg-gray-50"
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
                            className="px-1.5 py-1 rounded-md border border-transparent hover:border-gray-200 focus:border-gray-400 font-mono text-sm focus:outline-none disabled:bg-gray-50"
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
                            className="px-1.5 py-1 rounded-md border border-transparent hover:border-gray-200 focus:border-gray-400 font-mono text-sm text-right focus:outline-none disabled:bg-gray-50"
                          />
                          <input
                            type="text" inputMode="decimal" value={line.discountInput}
                            onChange={(e) => updateLine(idx, { discountInput: e.target.value })}
                            onBlur={(e) => updateLine(idx, { discountInput: (parseDollarsToCents(e.target.value) / 100).toFixed(2) })}
                            disabled={!isOpen || !note.trim()}
                            title={!note.trim() ? 'Add a note before applying a discount.' : undefined}
                            className="px-1.5 py-1 rounded-md border border-transparent hover:border-gray-200 focus:border-gray-400 font-mono text-sm text-right focus:outline-none disabled:bg-gray-50 disabled:cursor-not-allowed"
                          />
                          <span className="px-1.5 py-1 font-mono text-sm font-semibold text-gray-900 text-right">
                            {formatMoneyCents(ext)}
                          </span>
                          {isOpen ? (
                            <button onClick={() => removeLine(idx)}
                              className="p-1 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors">
                              <Trash2 size={14} />
                            </button>
                          ) : <span />}
                        </div>
                      );
                    });
                    })()
                  )}
                </div>

                {/* Add line */}
                {isOpen && (
                  <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-2 items-center px-3 py-1.5 bg-gray-50/60 border-t border-gray-100">
                    <select
                      value={pickerCategory}
                      onChange={(e) => {
                        setPickerCategory(e.target.value);
                        setPickerServiceId('');
                      }}
                      className="px-2 py-1.5 rounded-md border border-gray-200 font-mono text-sm bg-white focus:outline-none focus:border-gray-400"
                    >
                      <option value="">Category…</option>
                      {availableCategories.map((cat) => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                    </select>
                    <select
                      value={pickerServiceId}
                      disabled={!pickerCategory}
                      onChange={(e) => {
                        const svcId = e.target.value;
                        if (!svcId) return;
                        addCatalogService(svcId);
                        setPickerCategory('');
                        setPickerServiceId('');
                      }}
                      className="px-2 py-1.5 rounded-md border border-gray-200 font-mono text-sm bg-white focus:outline-none focus:border-gray-400 disabled:bg-gray-50 disabled:text-gray-300 disabled:cursor-not-allowed"
                    >
                      <option value="">Service…</option>
                      {servicesInCategory.map((s) => (
                        <option key={s.id} value={s.id}>{s.name} — ${s.price.toFixed(2)}</option>
                      ))}
                    </select>
                    <button onClick={addBlankCustomLine}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-white font-mono text-xs font-semibold transition-colors">
                      <Plus size={14} /> CUSTOM
                    </button>
                    <button onClick={() => setShowGiftModal(true)}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-pink-200 bg-pink-50 text-pink-700 hover:bg-pink-100 hover:border-pink-300 font-mono text-xs font-semibold transition-colors">
                      <Plus size={14} /> GIFT
                    </button>
                  </div>
                )}
              </div>

              {/* Note — collapsed by default, expandable to keep the layout compact */}
              {showNote ? (
                <div className="flex items-start gap-2">
                  <input
                    type="text"
                    value={note} onChange={(e) => setNote(e.target.value)}
                    disabled={!isOpen}
                    className="flex-1 px-2.5 py-1.5 rounded-lg border border-gray-200 font-mono text-sm focus:outline-none focus:border-gray-400 disabled:bg-gray-50"
                    placeholder="Note…"
                  />
                  {isOpen && !note && (
                    <button onClick={() => setShowNote(false)}
                      className="px-2 py-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-50 font-mono text-xs">
                      ×
                    </button>
                  )}
                </div>
              ) : (
                isOpen && (
                  <button onClick={() => setShowNote(true)}
                    className="self-start px-2 py-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-50 font-mono text-xs">
                    + Add note
                  </button>
                )
              )}
            </div>

            {/* Right column — totals + payments */}
            <div className="flex flex-col gap-2 min-h-0 overflow-y-auto">
              <div className="bg-gray-50 rounded-xl p-3 flex flex-col gap-1.5">
                <Row label="Subtotal" value={formatMoneyCents(subtotalCents)} />
                <RowEdit label="Discount" value={ticketDiscountInput}
                  onChange={(v) => setTicketDiscountInput(v)}
                  onBlur={(v) => setTicketDiscountInput((parseDollarsToCents(v) / 100).toFixed(2))}
                  disabled={!isOpen || !note.trim()}
                  title={!isOpen ? undefined : (!note.trim() ? 'Add a note before applying a discount.' : undefined)} />
                <RowEdit label="Tax" value={taxInput}
                  onChange={(v) => setTaxInput(v)}
                  onBlur={(v) => setTaxInput((parseDollarsToCents(v) / 100).toFixed(2))}
                  disabled={!isOpen} />
                <RowEdit label="Tip" value={tipInput}
                  onChange={(v) => setTipInput(v)}
                  onBlur={(v) => setTipInput((parseDollarsToCents(v) / 100).toFixed(2))}
                  disabled={!isOpen} />
                <div className="border-t border-gray-200 my-0.5" />
                <Row label="Total" value={formatMoneyCents(totalCents)} bold />
              </div>

              {/* Payment method buttons — pulled up so the cashier can pick a
                  tender immediately after seeing Total. Each click adds a
                  pending row below, defaulting to the remaining due. */}
              {isOpen ? (
                <>
                  <div className="grid grid-cols-3 gap-1.5">
                    <PayBtn label="Cash" tone="cash" onClick={() => addPending('cash')} />
                    <PayBtn label="Card" tone="card" onClick={() => addPending('visa_mc')} />
                    <PayBtn label="Gift" tone="gift" onClick={() => addPending('gift')} />
                  </div>
                  {pending.length > 0 && (
                    <div className="border border-gray-100 rounded-xl divide-y divide-gray-50">
                      {pending.map((p, idx) => (
                        <div key={idx} className="px-2.5 py-1.5 flex items-center gap-1.5">
                          <span className="font-mono text-[11px] font-bold text-gray-500 w-14">
                            {p.method === 'visa_mc' ? 'CARD' : p.method.toUpperCase()}
                          </span>
                          <span className="font-mono text-xs text-gray-400">$</span>
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
                      {pending.some((p) => p.method === 'gift') && (
                        <div className="px-2.5 py-1.5">
                          <label className="font-mono text-[10px] tracking-wider text-gray-400 uppercase">Gift card code</label>
                          {pending.map((p, idx) =>
                            p.method !== 'gift' ? null : (
                              <input
                                key={idx} type="text"
                                value={p.giftCardCode ?? ''}
                                onChange={(e) => patchPending(idx, { giftCardCode: e.target.value })}
                                className="mt-0.5 w-full px-2 py-1 rounded-md border border-gray-200 font-mono text-sm focus:outline-none focus:border-gray-400"
                                placeholder="GC-####"
                              />
                            ),
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="bg-gray-50 rounded-xl p-3 flex flex-col gap-1.5">
                    <Row
                      label="Amount Paid"
                      value={formatMoneyCents(pendingPaidCents)}
                      bold
                    />
                    <Row
                      label="Due"
                      value={formatMoneyCents(dueCents)}
                      bold
                      highlight={dueCents !== 0}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="border border-gray-100 rounded-xl divide-y divide-gray-50">
                    {ticket.payments.length === 0 ? (
                      <div className="px-3 py-2 font-mono text-xs text-gray-400 text-center">No payments captured.</div>
                    ) : (
                      ticket.payments.map((p) => (
                        <div key={p.id} className="px-2.5 py-1.5 flex items-center justify-between">
                          <span className="font-mono text-xs font-bold text-gray-500">
                            {p.method === 'visa_mc' ? 'CARD' : p.method.toUpperCase()}
                          </span>
                          <span className="font-mono text-sm text-gray-900">{formatMoneyCents(p.amountCents)}</span>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="bg-gray-50 rounded-xl p-3 flex flex-col gap-1.5">
                    <Row label="Amount Paid" value={formatMoneyCents(ticket.paidCents)} bold />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Footer — simplified action row. */}
        <div className="px-5 py-2.5 border-t border-gray-100 flex items-center justify-between gap-3 flex-wrap">
          {error && <p className="font-mono text-xs text-red-500 w-full sm:w-auto">{error}</p>}
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            <FooterBtn
              label="HISTORY"
              onClick={() => setShowHistory(true)}
              disabled={busy !== 'idle'}
            />
            <FooterBtn
              label="BOOK APPT"
              onClick={() => {
                // Pre-fill the appointment draft with this customer's info,
                // then open the appointment modal. The AppointmentModal will
                // run its own customer-match flow on top so any existing
                // profile shows up automatically.
                const parts = clientName.trim().split(/\s+/);
                const first = parts.shift() ?? '';
                const last = parts.join(' ');
                dispatch({
                  type: 'SET_APPOINTMENT_DRAFT',
                  draft: {
                    date: ticket.businessDate,
                    clientFirstName: first,
                    clientLastName: last,
                    clientPhone,
                  },
                });
                dispatch({ type: 'SET_MODAL', modal: 'addAppointment' });
                onClose();
              }}
              disabled={busy !== 'idle'}
            />
            {isOpen && (
              <>
                <span className="w-px h-6 bg-gray-200 mx-1" />
                <button onClick={() => { void doSave(); }} disabled={busy !== 'idle'}
                  className="px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 font-mono text-xs font-bold disabled:opacity-50">
                  {busy === 'saving' ? 'SAVING…' : 'SAVE'}
                </button>
                <button onClick={handleVoid} disabled={busy !== 'idle'}
                  className="px-3 py-1.5 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 font-mono text-xs font-bold disabled:opacity-50">
                  {busy === 'voiding' ? 'VOIDING…' : 'VOID'}
                </button>
                <button onClick={handleProcess} disabled={busy !== 'idle'}
                  className="px-4 py-1.5 rounded-lg bg-gray-900 text-white font-mono text-xs font-bold hover:bg-gray-800 disabled:opacity-50">
                  {busy === 'processing' ? 'PROCESSING…' : 'PROCESS'}
                </button>
              </>
            )}
            {!isOpen && (
              <button onClick={onClose}
                className="px-4 py-1.5 rounded-lg bg-gray-900 text-white font-mono text-xs font-bold hover:bg-gray-800">
                CLOSE
              </button>
            )}
          </div>
        </div>
      </div>
      {showHistory && (
        <CustomerHistoryModal
          clientName={clientName}
          clientPhone={clientPhone}
          onClose={() => setShowHistory(false)}
        />
      )}
      {showGiftModal && (
        <GiftCardSaleModal
          onClose={() => setShowGiftModal(false)}
          onAdd={(serial, valueCents, staff) => addGiftLine(serial, valueCents, staff)}
        />
      )}
      <ReceptionistPinGate
        open={showVoidGate}
        title="VOID TICKET"
        subtitle={`Voiding Ticket #${ticket.ticketNumber}. This can't be undone.`}
        showReason
        reasonPlaceholder="Reason (optional)"
        confirmLabel="VOID"
        tone="danger"
        receptionists={state.manicurists.filter((m) => m.isReceptionist)}
        onCancel={() => setShowVoidGate(false)}
        onConfirm={handleVoidConfirmed}
      />
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Format a YYYY-MM-DD business-date string as "Month Day, Year"
 * (e.g. "2026-05-12" → "May 12, 2026"). Falls back to the raw input
 * if the string doesn't look like a date.
 */
function formatBusinessDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10) - 1;
  const day = parseInt(m[3], 10);
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  if (month < 0 || month > 11) return iso;
  return `${months[month]} ${day}, ${year}`;
}

// ── small row primitives for the totals column ────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <label className="font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">{label}</label>
      {children}
    </div>
  );
}

function Row({ label, value, bold, highlight }: { label: string; value: string; bold?: boolean; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={`font-mono text-sm ${bold ? 'font-bold text-gray-900' : 'text-gray-500'}`}>{label}</span>
      <span className={`font-mono text-sm ${bold ? 'font-bold' : ''} ${highlight ? 'text-pink-600' : 'text-gray-900'}`}>{value}</span>
    </div>
  );
}

function RowEdit({
  label, value, onChange, onBlur, disabled, title,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: (v: string) => void;
  disabled?: boolean;
  /** Native tooltip shown on hover — used to explain why a row is disabled. */
  title?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2" title={title}>
      <span className="font-mono text-sm text-gray-500">{label}</span>
      <div className="flex items-center gap-1">
        <span className="font-mono text-xs text-gray-400">$</span>
        <input
          type="text" inputMode="decimal" value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => onBlur(e.target.value)}
          disabled={disabled}
          title={title}
          className="w-20 px-2 py-0.5 rounded-md border border-transparent hover:border-gray-200 focus:border-gray-400 font-mono text-sm text-right focus:outline-none disabled:bg-transparent bg-white disabled:text-gray-400 disabled:cursor-not-allowed"
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
      className={`px-2 py-2 rounded-lg border ${toneClasses} font-bebas text-base tracking-widest transition-colors`}
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


// ── Customer history modal ─────────────────────────────────────────────────
//
// Quick-look at the past closed tickets for the matched client. Fetched on
// demand from the tickets table, matching on phone (digits only) first then
// case-insensitive name fallback.

function CustomerHistoryModal({
  clientName,
  clientPhone,
  onClose,
}: {
  clientName: string;
  clientPhone: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<
    Array<{
      id: string;
      ticketNumber: number;
      businessDate: string;
      closedAt: string | null;
      totalCents: number;
      status: string;
      primaryStaff: string;
      services: string;
    }>
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const phoneDigits = (clientPhone ?? '').replace(/\D/g, '');
      const nameLower = (clientName ?? '').trim().toLowerCase();
      if (!phoneDigits && !nameLower) {
        setRows([]); setLoading(false); return;
      }
      const { supabase } = await import('../../lib/supabase');
      // Pull the newest 200 tickets; filter locally.
      const { data, error } = await supabase
        .from('tickets')
        .select('id, ticket_number, business_date, closed_at, total_cents, status, primary_manicurist_name, client_name, client_phone, items:ticket_items(name, kind)')
        .order('opened_at', { ascending: false })
        .limit(200);
      if (cancelled) return;
      if (error) { console.warn('[CustomerHistory] fetch failed:', error.message); setRows([]); setLoading(false); return; }
      type Row = {
        id: string; ticket_number: number; business_date: string;
        closed_at: string | null; total_cents: number; status: string;
        primary_manicurist_name: string; client_name: string; client_phone: string;
        items?: Array<{ name: string; kind: string }>;
      };
      const filtered = ((data ?? []) as Row[]).filter((t) => {
        const p = (t.client_phone ?? '').replace(/\D/g, '');
        if (phoneDigits && p === phoneDigits) return true;
        if (nameLower && (t.client_name ?? '').trim().toLowerCase() === nameLower) return true;
        return false;
      });
      const out = filtered.map((t) => ({
        id: t.id,
        ticketNumber: t.ticket_number,
        businessDate: t.business_date,
        closedAt: t.closed_at,
        totalCents: t.total_cents,
        status: t.status,
        primaryStaff: t.primary_manicurist_name || '—',
        services: (t.items ?? [])
          .filter((it) => it.kind === 'service')
          .map((it) => it.name)
          .join(', ') || '—',
      }));
      setRows(out);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [clientName, clientPhone]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h3 className="font-bebas text-xl tracking-widest text-gray-900">CUSTOMER HISTORY</h3>
            <p className="font-mono text-xs text-gray-500 mt-0.5">{clientName || 'Walk-in'}{clientPhone ? ` · ${clientPhone}` : ''}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {rows.length === 0 ? (
            <div className="px-5 py-10 text-center font-mono text-xs text-gray-400">
              {loading ? 'Loading…' : 'No previous tickets on file.'}
            </div>
          ) : (
            <div>
              <div className="grid grid-cols-[70px_110px_1fr_1fr_90px_90px] gap-2 px-5 py-2 bg-gray-50 border-b border-gray-100 font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">
                <span>Ticket</span>
                <span>Date</span>
                <span>Staff</span>
                <span>Services</span>
                <span className="text-right">Total</span>
                <span className="text-right">Status</span>
              </div>
              {rows.map((r) => (
                <div key={r.id} className="grid grid-cols-[70px_110px_1fr_1fr_90px_90px] gap-2 px-5 py-2.5 border-b border-gray-50 last:border-b-0 items-center">
                  <span className="font-mono text-sm font-bold text-gray-800">#{r.ticketNumber}</span>
                  <span className="font-mono text-xs text-gray-700">{r.businessDate}</span>
                  <span className="font-mono text-xs text-gray-800 truncate">{r.primaryStaff}</span>
                  <span className="font-mono text-xs text-gray-700 truncate" title={r.services}>{r.services}</span>
                  <span className="font-mono text-sm font-bold text-gray-900 text-right">{formatMoneyCents(r.totalCents)}</span>
                  <span className={`font-mono text-[10px] tracking-wider font-bold uppercase text-right ${
                    r.status === 'closed' ? 'text-gray-600' : r.status === 'voided' ? 'text-amber-600' : 'text-emerald-600'
                  }`}>{r.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
