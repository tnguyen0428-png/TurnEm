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
  getVisitId,
  linkClosedTicketToVisit,
  nextGiftCardSerial,
  parseDollarsToCents,
  updateOpenTicket,
  replaceTicketPayments,
  closeTicket,
  voidTicket,
  reallocateTurnsForStaffChanges,
  reconcileTicketItemsFromCompleted,
  applyTurnDelta,
  type ClosingPaymentInput,
} from '../../lib/tickets';
import { fetchOpenShift } from '../../lib/shifts';
import GiftCardSaleModal from './GiftCardSaleModal';
import GiftRedeemModal from './GiftRedeemModal';
import ReceptionistPinGate from '../shared/ReceptionistPinGate';
import { SERVICE_CATEGORIES } from '../../constants/services';
import { supabase } from '../../lib/supabase';
import { lookupGiftCardBalance, normalizeSerial, type GiftCardBalance } from '../../lib/giftCertificates';
import type { PaymentMethod, ServiceType, Ticket } from '../../types';

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
  // Snapshot of the original ticket_items.queue_entry_id so the visit link
  // survives the delete+reinsert cycle in updateOpenTicket. Without this
  // queue_entry_id ends up null after the first save and the
  // completed_services sync can no longer find the row.
  queueEntryId?: string | null;
  // True when this service was a client request — credits the manicurist
  // half a turn (or 1 for Combo) instead of the full base turn value.
  // Initialized from the matching completed_services.requestedServices on
  // mount; togglable via the R chip in the line row.
  isRequested?: boolean;
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

  // Closed-ticket edit unlock. By default a CLOSED ticket is read-only; a
  // receptionist can tap EDIT in the footer to open a PIN gate. Once they
  // confirm, `unlockedForEdit` flips true and the form behaves like an open
  // ticket (inputs editable, SAVE button visible) for the duration of this
  // modal instance.
  const [showEditGate, setShowEditGate] = useState(false);
  const [unlockedForEdit, setUnlockedForEdit] = useState(false);
  const canEdit = ticket.status === 'open' || unlockedForEdit;

  // When a receptionist unlocks a closed ticket, seed the `pending` editor
  // with the ticket's existing captured payments so the row is visible and
  // editable — otherwise the user sees an empty pending block and can't tell
  // what was previously recorded. Pre-fill only fires once per unlock.
  useEffect(() => {
    if (unlockedForEdit && ticket.status === 'closed') {
      setPending(
        ticket.payments
          .filter((p) => p.refundOf === null)
          .map((p) => ({
            method: p.method,
            amountInput: (p.amountCents / 100).toFixed(2),
            tenderedInput: p.tenderedCents != null ? (p.tenderedCents / 100).toFixed(2) : '',
            giftCardCode: p.giftCardCode ?? '',
          })),
      );
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlockedForEdit]);

  // Defensive ticket-items reconcile. Runs once on open for any 'open' ticket.
  // Compares what the cashier sees on the ticket to the completed_services
  // rows for the same visit (parent + split children) and auto-inserts any
  // missing service line. Stops the "Barbara had 2 pedis on the appt book
  // but the ticket only billed 1" pattern dead — the receipt now reflects
  // what was actually performed even if syncEntryToTicket lost a duplicate
  // line during a SPLIT_AND_ASSIGN race. Idempotent + safe to no-op.
  useEffect(() => {
    if (ticket.status !== 'open') return;
    let cancelled = false;
    (async () => {
      try {
        const result = await reconcileTicketItemsFromCompleted(
          ticket.id,
          ticket.queueEntryId,
          state.salonServices,
        );
        if (cancelled || !result || result.added === 0) return;
        console.info('[ticket-modal] reconciled ticket — added', result.added, 'missing service line(s)');
        if (result.ticket) onChanged?.(result.ticket);
      } catch (err) {
        console.warn('[ticket-modal] reconcile failed', err);
      }
    })();
    return () => { cancelled = true; };
  // Only on first open per ticket — re-running on every state.salonServices
  // change isn't necessary and could double-fire.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.id]);

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
    ticket.items.map((it) => {
      // Was this service flagged as a client request when its completed_services
      // row was first written? Find the matching entry by stripping the
      // index suffix from the queue_entry_id and checking requestedServices.
      let isRequested = false;
      if (it.queueEntryId && it.kind === 'service') {
        const visitId = it.queueEntryId.includes('#') ? it.queueEntryId.split('#')[0] : it.queueEntryId;
        const entry = state.completed.find((e) => e.id === visitId);
        // (1) Per-service request recorded on the completed_services row.
        if (entry?.requestedServices?.includes(it.name as ServiceType)) {
          isRequested = true;
        }
        // (2) Whole-entry request flag — the SingleServiceAssign path sets this
        //     without populating requestedServices per-service. Applies to the
        //     entry's own manicurist's lines.
        if (!isRequested && entry?.isRequested && (!it.staff1Id || entry.manicuristId === it.staff1Id)) {
          isRequested = true;
        }
        // (3) Authoritative cross-check against the linked appointment's
        //     serviceRequests — the SAME source the appt book uses to draw the
        //     red R. This guarantees "R on the book" == "R on the ticket" even
        //     if the completed_services request flags were dropped upstream,
        //     which otherwise makes the save-time turn recompute bake in a
        //     full (wrong) turn and clear the R. (Per Tony 2026-06-06: Lea's
        //     Gel Mani request for HANA was lost at the register → wrong turn.)
        if (!isRequested) {
          const norm = (s?: string) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
          // Prefer the in-memory appointment-id link (set by COMPLETE_SERVICE
          // this session); fall back to matching today's appointment by client
          // name, since the completed_services row loaded from the DB doesn't
          // carry the link after a reload.
          const apptId = entry?.originalAppointmentId ?? null;
          const ticketName = norm(ticket.clientName);
          const matched = state.appointments.some((a) => {
            const idHit = apptId != null && a.id === apptId;
            const nameHit = ticketName.length > 0 && norm(a.clientName) === ticketName;
            if (!idHit && !nameHit) return false;
            return (a.serviceRequests || []).some((r) =>
              r.service === it.name &&
              r.clientRequest === true &&
              (r.manicuristIds || []).length > 0 &&
              // Credit the request only when the staff who served this line is
              // the one the customer requested — mirrors the completion rule.
              (!it.staff1Id || (r.manicuristIds || []).includes(it.staff1Id)),
            );
          });
          if (matched) isRequested = true;
        }
      }
      return {
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
        queueEntryId: it.queueEntryId ?? null,
        isRequested,
      };
    }),
  );
  // Snapshot of the original line content per item id, captured once on
  // mount. We diff this against the current `lines` state on Save to know:
  //   - which manicurist reassignments to push through the turn-credit
  //     reallocation path
  //   - which service-name changes need to propagate back to the matching
  //     completed_services row + the manicurist's totalTurns
  const originalStaffByItemId = useMemo(() => {
    const m = new Map<string, {
      staff1Id: string | null;
      queueEntryId: string | null;
      name: string;
      serviceId: string | null;
    }>();
    for (const it of ticket.items) {
      m.set(it.id, {
        staff1Id: it.staff1Id,
        queueEntryId: it.queueEntryId ?? null,
        name: it.name,
        serviceId: it.serviceId,
      });
    }
    return m;
  }, [ticket.items]);

  // ─── Ticket-level totals state ────────────────────────────────────────────
  const [ticketDiscountInput, setTicketDiscountInput] = useState((ticket.discountCents / 100).toFixed(2));
  const [taxInput, setTaxInput] = useState((ticket.taxCents / 100).toFixed(2));
  const [tipInput, setTipInput] = useState((ticket.tipCents / 100).toFixed(2));

  // ─── Payments scratchpad (for processing on close) ────────────────────────
  // Seed from any payments already saved on this ticket so a payment SAVED on
  // an OPEN ticket (held/partial, not yet processed) reloads when the ticket is
  // reopened instead of vanishing. Refund rows are audit-only and excluded.
  // (Per Tony 2026-06-06: allow saving a payment on an open ticket.)
  const [pending, setPending] = useState<PendingPayment[]>(() =>
    ticket.payments
      .filter((p) => p.refundOf === null)
      .map((p) => ({
        method: p.method,
        amountInput: (p.amountCents / 100).toFixed(2),
        tenderedInput: p.tenderedCents != null ? (p.tenderedCents / 100).toFixed(2) : '',
        giftCardCode: p.giftCardCode ?? '',
      })),
  );

  // ─── Explicitly-removed item ids ──────────────────────────────────────────
  // Tracks which existing ticket_items the cashier removed via the trash icon
  // during this modal session. Sent through to updateOpenTicket on save so it
  // knows to DELETE only these rows — anything else in the DB but missing
  // from `lines` (e.g. a sibling staff's line the trigger inserted after
  // mount) is preserved. See the diff-based save in lib/tickets.ts.
  const [removedItemIds, setRemovedItemIds] = useState<string[]>([]);

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
  // PROCESS is only allowed once the cashier has captured payment that
  // matches the total exactly. Without this gate, hitting PROCESS on a
  // partially-paid ticket leaves the cashier with a closed ticket whose
  // payments don't reconcile against the day's drawer.

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

  // When a fresh service line on an existing (parent) ticket gets a staff
  // assignment, flip that manicurist's card to BUSY and surface the service
  // they're rendering. We do this by:
  //   1. Creating (or updating) a synthetic "add-child" queue entry whose
  //      id is `${visitId}-add-${staffId}`. It carries the added service in
  //      its `services` array so ManicuristCard's `currentClient.services`
  //      render can display it. parentQueueId points at the visit so the
  //      ticket-creation trigger still pegs work onto the same ticket.
  //   2. Pointing the manicurist's `currentClient` at the synthetic child
  //      so the queue panel finds it via getClientForManicurist.
  //
  // turnValue stays 0 on the child — turn credit for the new staff is
  // already handled by reallocateTurnsForStaffChanges during ticket save,
  // and we don't want a second crediting via COMPLETE_SERVICE.
  //
  // Cleared automatically when the ticket is closed or voided (see
  // handleProcess / handleVoidConfirmed below — both sweep up any
  // manicurist still pointing at a `${visitId}-add-` child and remove
  // those queue entries).
  //
  // Guard: only fire when the manicurist isn't already busy with a DIFFERENT
  // client — otherwise we'd clobber their existing work pointer. We treat
  // "already busy with the same visit's primary OR add-child" as fine to
  // overwrite/extend.
  function ensureManicuristBusyForAddedLine(line: DraftLine) {
    if (line.kind !== 'service') return;
    if (line.existingId) return;
    if (!line.staff1Id) return;
    const visitId = ticket.queueEntryId;
    if (!visitId) return;
    const target = state.manicurists.find((m) => m.id === line.staff1Id);
    if (!target) return;
    const svcName = (line.name ?? '').trim();
    if (!svcName) {
      // Without a service name there's nothing to append to a queue entry.
      // Just flip the card to busy pointing at the visit so the cashier
      // still sees a status change.
      dispatch({
        type: 'UPDATE_MANICURIST',
        id: line.staff1Id,
        updates: { status: 'busy', currentClient: visitId },
      });
      return;
    }

    // CRITICAL: when this staff already has a queue entry for THIS visit
    // (a SPLIT_AND_ASSIGN child, an earlier add-child, or any descendant
    // whose root visit id matches), APPEND the new service to that
    // entry's services array rather than creating a separate "add-child"
    // sibling. Creating a second entry causes the queue->ticket trigger
    // to fire twice for the same (visit, staff, service) tuple — once
    // for the original entry and once for the new add-child — which
    // produces duplicate ticket_items. Symptom: ticket #5 ended up with
    // Z-TEST 1 having TWO Gel Pedicure lines (one on the split child's
    // qe, one on the add-child's qe) plus a phantom Gel Pedicure on
    // Z-TEST 4 from a stray add-child.
    //
    // We resolve "root visit" via getVisitId on parentQueueId so split
    // children (`${visit}-${staff}`), nested splits, AND prior
    // add-children (`${visit}-add-${staff}`) all share the same root.
    const reusable = state.queue.find((q) =>
      q.assignedManicuristId === line.staff1Id &&
      getVisitId(q.parentQueueId ?? q.id) === visitId
    );

    const isAlreadyOnThisVisit =
      !target.currentClient ||
      target.currentClient === visitId ||
      (reusable && target.currentClient === reusable.id) ||
      target.currentClient.startsWith(`${visitId}-`);
    if (target.status === 'busy' && !isAlreadyOnThisVisit) return;

    const now = Date.now();

    if (reusable) {
      // Update the existing entry's services array — no new queue row,
      // no second trigger fire for the same (visit, staff) pair. The
      // service-edit sync block in doSave will see this on save and
      // reconcile the rest. If the service is already in the list, no-op.
      if (!reusable.services.includes(svcName as ServiceType)) {
        const services = [...reusable.services, svcName as ServiceType];
        dispatch({
          type: 'UPDATE_CLIENT',
          id: reusable.id,
          updates: { services, assignedManicuristId: line.staff1Id },
        });
      }
      dispatch({
        type: 'UPDATE_MANICURIST',
        id: line.staff1Id,
        updates: { status: 'busy', currentClient: reusable.id },
      });
      return;
    }

    // No existing entry for this (visit, staff) — create a brand-new
    // add-child. Use a deterministic id so re-runs don't pile up duplicates.
    const addChildId = `${visitId}-add-${line.staff1Id}`;
    dispatch({
      type: 'ADD_CLIENT',
      client: {
        id: addChildId,
        parentQueueId: visitId,
        clientName: clientName || ticket.clientName || 'Walk-in',
        services: [svcName as ServiceType],
        turnValue: 0,
        serviceRequests: [],
        requestedManicuristId: null,
        isRequested: false,
        isAppointment: false,
        assignedManicuristId: line.staff1Id,
        status: 'inProgress',
        arrivedAt: now,
        startedAt: now,
        completedAt: null,
        extraTimeMs: 0,
      },
    });
    dispatch({
      type: 'UPDATE_MANICURIST',
      id: line.staff1Id,
      updates: { status: 'busy', currentClient: addChildId },
    });

    // Belt-and-suspenders direct DB write (see commit 5ffadda for why).
    const nowIso = new Date(now).toISOString();
    void supabase.from('queue_entries').upsert({
      id: addChildId,
      parent_queue_id: visitId,
      client_name: clientName || ticket.clientName || 'Walk-in',
      service: svcName,
      services: [svcName],
      turn_value: 0,
      service_requests: [],
      requested_manicurist_id: null,
      is_requested: false,
      is_appointment: false,
      assigned_manicurist_id: line.staff1Id,
      status: 'inProgress',
      arrived_at: nowIso,
      started_at: nowIso,
      completed_at: null,
      extra_time_ms: 0,
    }, { onConflict: 'id' }).then(({ error }) => {
      if (error) console.warn('[ticket modal] add-child direct upsert:', error.message);
    });
  }

  function updateLine(idx: number, patch: Partial<DraftLine>) {
    const before = lines[idx];
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
    if (
      before &&
      !before.existingId &&
      patch.staff1Id !== undefined &&
      patch.staff1Id !== null &&
      patch.staff1Id !== before.staff1Id
    ) {
      // Tear down the OLD staff's add-child first when the cashier swaps
      // the staff on an unsaved line. Without this step, picking staff A
      // then changing to B leaves A's add-child queue entry orphaned and
      // A's card stuck on BUSY pointing at it. removeLine has equivalent
      // teardown logic for the line-delete path; this mirrors it for the
      // staff-swap path. Mirrors the same "any remaining lines for this
      // staff?" check so a multi-line ticket where A still has work
      // elsewhere keeps A busy on the narrowed services.
      if (before.staff1Id) {
        const visitId = ticket.queueEntryId;
        if (visitId) {
          const oldStaffId = before.staff1Id;
          const remainingForOldStaff = lines
            .filter((l, i) =>
              i !== idx &&
              l.kind === 'service' &&
              l.staff1Id === oldStaffId,
            )
            .map((l) => (l.name ?? '').trim())
            .filter((n) => n.length > 0);
          const oldAddChildId = `${visitId}-add-${oldStaffId}`;
          const oldAddChild = state.queue.find((q) => q.id === oldAddChildId);
          if (remainingForOldStaff.length === 0) {
            // Old staff has no other work on this ticket. Drop the
            // add-child and return them to AVAILABLE if they were
            // pointing at it.
            if (oldAddChild) {
              dispatch({ type: 'REMOVE_CLIENT', id: oldAddChildId });
            }
            const m = state.manicurists.find((mm) => mm.id === oldStaffId);
            if (m && m.currentClient === oldAddChildId) {
              dispatch({
                type: 'UPDATE_MANICURIST',
                id: m.id,
                updates: { status: 'available', currentClient: null },
              });
            }
          } else if (oldAddChild) {
            // Narrow the old staff's add-child services to what's left
            // so their card stops advertising the just-swapped service.
            dispatch({
              type: 'UPDATE_CLIENT',
              id: oldAddChildId,
              updates: { services: remainingForOldStaff as ServiceType[] },
            });
          }
        }
      }
      ensureManicuristBusyForAddedLine({ ...before, ...patch });
    }
  }
  function removeLine(idx: number) {
    const removed = lines[idx];
    setLines((prev) => prev.filter((_, i) => i !== idx));
    // Record the explicit removal so the diff-based updateOpenTicket DELETEs
    // this row in the DB. Lines without `existingId` were never persisted,
    // so they don't need a tombstone — the trash icon click is enough.
    if (removed?.existingId) {
      setRemovedItemIds((prev) => (prev.includes(removed.existingId!) ? prev : [...prev, removed.existingId!]));
    }

    // Tear down the synthetic add-child if this was a just-added (unsaved)
    // line. Saved lines (have `existingId`) go through the modal save's
    // removed-line sync path, which already handles queue-entry cleanup.
    // For unsaved adds the queue child was created eagerly by
    // ensureManicuristBusyForAddedLine and would otherwise sit around
    // forever (the card stays BUSY and Cancel may find no client to act
    // on) if the user just removes the line and doesn't save.
    if (!removed || removed.existingId || removed.kind !== 'service' || !removed.staff1Id) return;
    const visitId = ticket.queueEntryId;
    if (!visitId) return;

    const remainingForStaff = lines
      .filter((l, i) => i !== idx && l.kind === 'service' && l.staff1Id === removed.staff1Id)
      .map((l) => (l.name ?? '').trim())
      .filter((n) => n.length > 0);

    const addChildId = `${visitId}-add-${removed.staff1Id}`;
    const addChild = state.queue.find((q) => q.id === addChildId);

    if (remainingForStaff.length === 0) {
      // Last line for this staff is gone — drop the add-child and free
      // the manicurist if they were pointing at it.
      if (addChild) {
        dispatch({ type: 'REMOVE_CLIENT', id: addChildId });
      }
      const m = state.manicurists.find((mm) => mm.id === removed.staff1Id);
      if (m && m.currentClient === addChildId) {
        dispatch({
          type: 'UPDATE_MANICURIST',
          id: m.id,
          updates: { status: 'available', currentClient: null },
        });
      }
      return;
    }

    // Staff still has other lines for this visit — narrow the add-child's
    // services to what's left so the card stops advertising the removed
    // one.
    if (addChild) {
      dispatch({
        type: 'UPDATE_CLIENT',
        id: addChildId,
        updates: { services: remainingForStaff as ServiceType[] },
      });
    }
  }
  function addCatalogService(svcId: string) {
    const svc = sortedServices.find((s) => s.id === svcId);
    if (!svc) return;
    // Do NOT default the staff to the ticket's primary. The cashier must
    // explicitly pick a staff via the dropdown so ensureManicuristBusyForAddedLine
    // only runs for the intended manicurist. Previously, defaulting to the
    // primary staff appended the new service to that primary's queue entry
    // immediately, which caused a phantom ticket_item to be inserted by
    // updateOpenTicket when the cashier later changed the dropdown to a
    // different staff (the modal's `lines` state held a stale draft).
    const newLine: DraftLine = {
      serviceId: svc.id,
      name: svc.name,
      staff1Id: null,
      staff1Name: '',
      staff1Color: '#9ca3af',
      staff2Id: null,
      staff2Name: '',
      staff2Color: '#9ca3af',
      priceInput: svc.price.toFixed(2),
      discountInput: '0.00',
      quantity: 1,
      kind: 'service',
    };
    setLines((prev) => [...prev, newLine]);
    // No ensureManicuristBusyForAddedLine here — staff is null at this point.
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

  // ─── Gift card sale modal ─────────────────────────────────────────────────
  //
  // Sequential gift serials must work for multiple gift cards added to the
  // SAME ticket (e.g. a couple buying two $50 gifts). Strategy:
  //   1. Pre-fetch the salon-wide max serial ONCE when this TicketModal
  //      mounts. Cached in `dbMaxSerial`. The DB doesn't get re-queried for
  //      subsequent ADD GIFT clicks on the same ticket — instead we derive
  //      the next number synchronously from cache + current draft lines.
  //   2. On each ADD GIFT click, compute the next serial as
  //      `max(dbMaxSerial, ...pendingSerialsFromCurrentLines) + 1`.
  //   3. Pass that pre-computed serial as a prop to GiftCardSaleModal so it
  //      can render the number instantly (no loading state, no async race).
  //
  // The "next number pops up the moment you click ADD GIFT" UX comes from
  // (3) — the modal opens already showing the next serial because we
  // computed it before mounting it. Each subsequent gift bumps further past
  // the previously-added (unsaved) lines, so a 2nd / 3rd / Nth gift on the
  // same ticket gets a unique sequential number every time.

  const [dbMaxSerial, setDbMaxSerial] = useState<number | null>(null);
  const [giftModalSerial, setGiftModalSerial] = useState<string | null>(null);
  // Gift-certificate REDEMPTION dialog (distinct from the gift-card SALE modal
  // above). Opened from the "Gift" tender button; on save it pushes a gift
  // pending payment row. (Per Tony 2026-06-08.)
  const [showGiftRedeem, setShowGiftRedeem] = useState(false);

  // Pre-fetch the salon-wide max gift serial when this ticket modal opens.
  // Idempotent in the React sense — if the fetch fails we leave dbMaxSerial
  // null and the openGiftModal() helper falls back to a fresh fetch on
  // first click. The "…" delay only ever appears on the first ADD GIFT
  // click if the user clicks faster than this fetch resolves.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await nextGiftCardSerial();
        // Serials are "TM<n>" (the TurnEm sequence). Parse the numeric part.
        const n = parseInt(s.replace(/^TM/i, ''), 10);
        if (!cancelled && Number.isFinite(n)) {
          // nextGiftCardSerial returns the next serial. We store the max
          // (next-1) so openGiftModal can add 1 once it knows about pendingSerials.
          setDbMaxSerial(n - 1);
        }
      } catch (err) {
        console.warn('[ticket modal] gift serial prefetch failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function openGiftModal() {
    // Pull pending serials from THIS modal's current draft lines. Includes
    // both gift lines loaded from ticket.items at mount (existingId set) and
    // gift lines added during this session (existingId undefined) — both
    // sit in `lines` with kind='gift_card_sale'.
    const pendingFromLines = lines
      .filter((l) => l.kind === 'gift_card_sale')
      .map((l) => {
        // Only the TurnEm "TM<n>" sequence counts here; old SalonBiz digit
        // serials live in a separate space and never increment this counter.
        const m = (l.name ?? '').match(/#TM(\d+)/i);
        return m ? parseInt(m[1], 10) : NaN;
      })
      .filter((n) => Number.isFinite(n));

    // Resolve DB max — usually pre-fetched; if not, fetch now (one-time
    // cost on the first ADD GIFT click before prefetch resolved).
    let max = dbMaxSerial;
    if (max == null) {
      try {
        const s = await nextGiftCardSerial();
        const n = parseInt(s.replace(/^TM/i, ''), 10);
        if (Number.isFinite(n)) {
          max = n - 1;
          setDbMaxSerial(max);
        }
      } catch (err) {
        console.warn('[ticket modal] gift serial fetch failed', err);
      }
    }
    // Floor at 10099 so the first TurnEm card is TM10100 even when nothing is
    // found yet. The "TM" prefix distinguishes these from imported SalonBiz cards.
    const next = Math.max(max ?? 10099, ...pendingFromLines, 10099) + 1;
    setGiftModalSerial(`TM${next}`);
  }

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

  // ─── Gift card balance lookup ─────────────────────────────────────────────
  //
  // Keyed by normalized serial (so the cashier can switch between two gift
  // pending rows without re-fetching). Each entry holds the lookup result OR
  // 'loading' while the supabase query is in flight. When the cashier types
  // a new serial into the gift_card_code field, we look it up on blur and
  // stash the result here so the UI can:
  //   - show "Balance $X.XX" in pink next to the gift card code label
  //   - hard-cap that pending row's amount input at the remaining balance
  const [giftBalances, setGiftBalances] = useState<Record<string, GiftCardBalance | 'loading' | 'unknown'>>({});

  async function refreshGiftBalance(rawSerial: string) {
    const norm = normalizeSerial(rawSerial);
    if (!norm) return;
    setGiftBalances((prev) => ({ ...prev, [norm]: 'loading' }));
    try {
      const result = await lookupGiftCardBalance(norm, ticket.id);
      setGiftBalances((prev) => ({ ...prev, [norm]: result }));
    } catch (err) {
      console.warn('[ticket modal] gift balance lookup failed:', err);
      setGiftBalances((prev) => ({ ...prev, [norm]: 'unknown' }));
    }
  }

  // Cap amount input at the looked-up balance. Returns the input string
  // clamped to min(typed, balance). If no balance known yet (loading or
  // unknown serial), passes through unchanged.
  function capGiftAmountToBalance(rawSerial: string, amountInput: string): string {
    const norm = normalizeSerial(rawSerial);
    const lookup = norm ? giftBalances[norm] : undefined;
    if (!lookup || lookup === 'loading' || lookup === 'unknown') return amountInput;
    if (!lookup.found) return amountInput;
    const typedCents = parseDollarsToCents(amountInput);
    if (typedCents <= lookup.balanceCents) return amountInput;
    return (lookup.balanceCents / 100).toFixed(2);
  }

  // Hard guard: a gift certificate can't be redeemed for more than its
  // remaining balance. capGiftAmountToBalance above is only a SOFT input clamp
  // — it passes the value through while the balance is still loading/unknown,
  // and canProcess checks only the grand total — so a $35 cert was redeemed
  // for $65 (Bella, ticket #40, 6/7). This re-checks every gift pending row at
  // save/process time, summing per serial so two rows on one cert can't
  // jointly overdraw it. Returns an error string to show, or null when OK.
  async function giftOverdraftError(): Promise<string | null> {
    const bySerial = new Map<string, { amountCents: number; label: string }>();
    for (const p of pending) {
      if (p.method !== 'gift') continue;
      const norm = normalizeSerial(p.giftCardCode ?? '');
      if (!norm) return 'Enter the gift certificate number for the gift payment.';
      const amt = parseDollarsToCents(p.amountInput);
      const prev = bySerial.get(norm);
      bySerial.set(norm, { amountCents: (prev?.amountCents ?? 0) + amt, label: (p.giftCardCode ?? norm).trim() });
    }
    for (const [norm, g] of bySerial) {
      const bal = await lookupGiftCardBalance(norm, ticket.id);
      if (bal.lookupError) {
        return `Couldn't verify gift cert #${g.label} — check the connection and try again.`;
      }
      if (!bal.found) {
        return `Gift cert #${g.label} isn't in the system — double-check the number. Only gift certs sold here can be redeemed.`;
      }
      if (g.amountCents > bal.balanceCents) {
        return `Gift cert #${g.label} only has ${formatMoneyCents(bal.balanceCents)} left — you applied ${formatMoneyCents(g.amountCents)}. Lower it and put the remainder on another tender.`;
      }
    }
    return null;
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
      // Heal legacy nulls: if this line has no queueEntryId of its own but
      // the ticket itself does, write the ticket's qid back so the next save
      // doesn't need the fallback.
      queueEntryId: l.queueEntryId ?? (l.kind === 'service' ? (ticket.queueEntryId ?? null) : null),
    }));
  }

  const canProcess =
    isOpen &&
    lines.length > 0 &&
    // Zero-balance tickets process without a payment row; non-zero requires
    // at least one pending payment that fully covers the total.
    (totalCents === 0 || pending.length > 0) &&
    Math.abs(pendingPaidCents - totalCents) === 0;

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
      removedItemIds,
    });
    setBusy('idle');
    if (!saved) {
      setError('Could not save — check connection and try again.');
      return null;
    }
    // Save succeeded — clear the explicit-removal log so a follow-up edit
    // in the same modal session doesn't re-send DELETEs for ids that no
    // longer exist (the second DELETE would be a no-op but the noise is
    // confusing in the logs).
    if (removedItemIds.length > 0) setRemovedItemIds([]);
    // Turn reallocation: any line whose staff1 changed reassigns the turn
    // credit from the old assignee to the new one. Only service-kind lines
    // with a queue_entry_id (i.e. ones tied to a completed entry) qualify;
    // manually-added lines never had a turn credited to begin with.
    const changes: Array<{
      queueEntryId: string;
      serviceName: string;
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
        serviceName: l.name,
        oldStaffId: orig.staff1Id,
        newStaffId: l.staff1Id,
        newStaffName: l.staff1Name,
        newStaffColor: l.staff1Color,
      });
    }
    if (changes.length > 0) {
      void reallocateTurnsForStaffChanges(changes);
    }

    // ── Appt-book sync: mirror the cashier's per-line edits — BOTH a staff
    // reassignment AND a service rename — onto the linked appointment so the
    // book shows what was actually done. Accumulated per appointment so several
    // edits on one appt can't clobber each other, and it runs for staff-only,
    // name-only, or both. (Per Tony 2026-06-07: a ticket service/manicurist
    // change must show in the appt book — e.g. Emree's "Polish Change Feet" was
    // changed to "Gel Polish Feet" but the book kept the old name.)
    //
    // Link priority: queue.originalAppointment.id (in-progress) →
    // completed.originalAppointmentId (awaiting payment, same session) →
    // client-name match against today's appts (reopened closed ticket, where
    // the in-memory appt link is gone).
    {
      type Appt = typeof state.appointments[number];
      type SvcReq = Appt['serviceRequests'][number];
      type Svc = Appt['services'][number];
      const norm = (s?: string) => (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

      const resolveApptId = (orig: { queueEntryId: string | null; name: string }): string | null => {
        const qid = orig.queueEntryId;
        const queueEntry = qid ? state.queue.find((q) => q.id === qid) : null;
        const completedRow = qid ? state.completed.find((cs) => cs.id === qid) : null;
        const direct = queueEntry?.originalAppointment?.id ?? completedRow?.originalAppointmentId ?? null;
        if (direct) return direct;
        const tname = norm(ticket.clientName);
        const hit = state.appointments.find(
          (a) => norm(a.clientName) === tname && (a.services ?? []).some((s) => norm(s) === norm(orig.name)),
        );
        return hit?.id ?? null;
      };

      type Working = { services: Svc[]; serviceRequests: SvcReq[]; manicuristId: string | null; touched: boolean };
      const work = new Map<string, Working>();
      const getWork = (apptId: string): Working | null => {
        const existing = work.get(apptId);
        if (existing) return existing;
        const appt = state.appointments.find((a) => a.id === apptId);
        if (!appt) return null;
        const w: Working = {
          services: [...(appt.services ?? [])],
          serviceRequests: (appt.serviceRequests ?? []).map((r) => ({ ...r, manicuristIds: [...(r.manicuristIds ?? [])] })),
          manicuristId: appt.manicuristId ?? null,
          touched: false,
        };
        work.set(apptId, w);
        return w;
      };

      for (const l of lines) {
        if (l.kind !== 'service' || !l.existingId) continue;
        const orig = originalStaffByItemId.get(l.existingId);
        if (!orig) continue;
        const oldName = orig.name?.trim();
        const newName = l.name?.trim();
        const nameChanged = !!oldName && !!newName && oldName !== newName;
        const staffChanged = orig.staff1Id !== l.staff1Id;
        if (!nameChanged && !staffChanged) continue;
        const apptId = resolveApptId(orig);
        if (!apptId) continue;
        const w = getWork(apptId);
        if (!w) continue;

        // services[]: rename the first occurrence of the old service name.
        if (nameChanged && oldName && newName) {
          const si = w.services.findIndex((s) => s === oldName);
          if (si >= 0) w.services[si] = newName as Svc;
          else if (!w.services.includes(newName as Svc)) w.services.push(newName as Svc);
          w.touched = true;
        }

        // serviceRequests[]: update the request that owns this line (matched by
        // old service + old staff, else by old service name) with the new name
        // and/or new staff. clientRequest / startTime are preserved.
        let ri = w.serviceRequests.findIndex(
          (r) => r.service === oldName && (orig.staff1Id ? (r.manicuristIds ?? []).includes(orig.staff1Id) : true),
        );
        if (ri < 0) ri = w.serviceRequests.findIndex((r) => r.service === oldName);
        if (ri >= 0) {
          const r = w.serviceRequests[ri];
          w.serviceRequests[ri] = {
            ...r,
            service: (newName || r.service) as Svc,
            manicuristIds: l.staff1Id ? [l.staff1Id] : (r.manicuristIds ?? []),
          };
          w.touched = true;
        } else if (l.staff1Id && (newName || oldName)) {
          // No matching request (e.g. walk-in saved with empty service_requests)
          // — synth one so the book renders this line under the right staff/name.
          w.serviceRequests.push({
            service: (newName || oldName) as Svc,
            manicuristIds: [l.staff1Id],
            clientRequest: false,
          } as SvcReq);
          w.touched = true;
        }

        // Keep the appt's primary column in sync if it was the reassigned staff.
        if (staffChanged && l.staff1Id && w.manicuristId === orig.staff1Id) {
          w.manicuristId = l.staff1Id;
        }
      }

      for (const [apptId, w] of work) {
        if (!w.touched) continue;
        const updates: Partial<Appt> = {
          services: w.services,
          service: (w.services[0] ?? '') as Svc,
          serviceRequests: w.serviceRequests,
          manicuristId: w.manicuristId,
        };
        dispatch({ type: 'UPDATE_APPOINTMENT', id: apptId, updates });
      }
    }

    // In-progress queue sync: when a line's service NAME is changed on an
    // existing in-progress ticket (e.g. customer asks to upgrade Pedicure ->
    // Gel Pedicure), mirror the change onto the matching queue_entries row
    // so the manicurist's BUSY card shows the new service and their
    // total_turns get the delta. Skip lines whose staff also changed —
    // those go through reallocateTurnsForStaffChanges above. Skip if the
    // queue entry no longer exists (already completed) — completed_services
    // path handles that case.
    for (const l of lines) {
      if (l.kind !== 'service' || !l.existingId) continue;
      const orig = originalStaffByItemId.get(l.existingId);
      if (!orig) continue;
      if (orig.staff1Id !== l.staff1Id) continue;
      // Find the queue entry for THIS staff on THIS visit. The ticket_item
      // may carry the bare visit id as queue_entry_id, but the actual
      // queue entry is often a split child (`${visitId}-${staffId}`) or a
      // NESTED split child (`${visitId}-${parentSplit}-${staffId}`) whose
      // parentQueueId points at an intermediate ancestor — NOT the root
      // visit. A naive `q.parentQueueId === visitId` misses those.
      // getVisitId strips down to the leading UUID so both single- and
      // multi-level splits resolve to the same root.
      const visitId = ticket.queueEntryId;
      if (!visitId || !l.staff1Id) continue;
      const entry = state.queue.find(
        (q) =>
          getVisitId(q.parentQueueId ?? q.id) === visitId &&
          q.assignedManicuristId === l.staff1Id,
      );
      if (!entry) continue;
      const oldName = orig.name?.trim();
      const newName = l.name?.trim();
      if (!oldName || !newName || oldName === newName) continue;
      const idx = entry.services.indexOf(oldName as ServiceType);
      if (idx === -1) continue;
      const updatedServices = [...entry.services];
      updatedServices[idx] = newName as ServiceType;
      const newTurnValue = updatedServices.reduce((sum, sv) => {
        const cat = state.salonServices.find((s) => s.name === sv);
        return sum + Number(cat?.turnValue ?? 0);
      }, 0);
      dispatch({
        type: 'UPDATE_CLIENT',
        id: entry.id,
        updates: { services: updatedServices, turnValue: newTurnValue },
      });
    }

    // Removed-line sync: when a line that existed at mount is no longer in
    // `lines`, mirror the removal onto the matching in-progress queue entry.
    // Without this, the existing appendItemsToTicket / reconcile flow re-adds
    // the ticket_item on the next queue tick because the queue entry still
    // lists the service. If the queue entry's services array becomes empty
    // after removal, drop the entry entirely (REMOVE_CLIENT) so the
    // manicurist is no longer marked busy with phantom work. The
    // UPDATE_CLIENT reducer applies the turn-value delta to total_turns;
    // REMOVE_CLIENT alone doesn't, so we explicitly subtract the entry's
    // current turn credit from the assigned manicurist before removing.
    {
      const remainingItemIds = new Set(lines.filter((l) => l.existingId).map((l) => l.existingId as string));
      const visitId = ticket.queueEntryId;
      if (visitId) {
        for (const [itemId, orig] of originalStaffByItemId) {
          if (remainingItemIds.has(itemId)) continue;
          if (!orig.staff1Id || !orig.name) continue;
          // Match via getVisitId so NESTED split children (e.g.
          // `${visit}-${innerParent}-${staffId}`, whose parentQueueId
          // points at the inner split rather than the root visit) still
          // resolve. The previous `q.parentQueueId === visitId` check
          // only caught one level of nesting — split-of-a-split entries
          // sailed past the removed-line sync and kept the service on
          // the queue card forever. Symptom: ticket #2 deleted Z-TEST 2's
          // line but Z-TEST 2's card kept "Pedicure" because their entry
          // was a grandchild of the visit.
          const entry = state.queue.find(
            (q) =>
              getVisitId(q.parentQueueId ?? q.id) === visitId &&
              q.assignedManicuristId === orig.staff1Id,
          );
          if (!entry) continue;
          const oldName = orig.name.trim();
          const idx = entry.services.indexOf(oldName as ServiceType);
          if (idx === -1) continue;
          const updatedServices = [...entry.services];
          updatedServices.splice(idx, 1);
          if (updatedServices.length === 0) {
            const credit = Number(entry.turnValue) || 0;
            if (credit > 0 && entry.assignedManicuristId) {
              const m = state.manicurists.find((mm) => mm.id === entry.assignedManicuristId);
              if (m) {
                dispatch({
                  type: 'UPDATE_MANICURIST',
                  id: m.id,
                  updates: {
                    totalTurns: Math.max(0, (m.totalTurns || 0) - credit),
                    status: m.currentClient === entry.id ? 'available' : m.status,
                    currentClient: m.currentClient === entry.id ? null : m.currentClient,
                  },
                });
              }
            }
            dispatch({ type: 'REMOVE_CLIENT', id: entry.id });
          } else {
            const newTurnValue = updatedServices.reduce((sum, sv) => {
              const cat = state.salonServices.find((s) => s.name === sv);
              return sum + Number(cat?.turnValue ?? 0);
            }, 0);
            dispatch({
              type: 'UPDATE_CLIENT',
              id: entry.id,
              updates: { services: updatedServices, turnValue: newTurnValue },
            });
          }
        }
      }
    }

    // Staff-change sync: when an existing line's staff1Id changes (cashier
    // swaps Kayla → Z-TEST 1 on a Gel Pedicure), mirror the swap onto the
    // queue side so:
    //   1. The OLD staff's queue card stops showing the service (the service
    //      is removed from her queue_entry's services array; if that empties
    //      her services, her queue_entry is deleted entirely).
    //   2. The NEW staff's queue card shows the service (added to her existing
    //      queue_entry on this visit, or a synthetic add-child is created if
    //      she didn't have one).
    //
    // Without this block, ticket_items.staff1_id updates via updateOpenTicket
    // but queue_entries stays stale — symptom: ticket #15 swapped Kayla → Z-TEST 1
    // on a Gel Pedicure line, the cashier saw the name flip in the modal, but
    // Kayla's manicurist card kept showing the work and Z-TEST 1's didn't
    // pick it up. Turns also didn't move because reallocateTurnsForStaffChanges
    // only repoints completed_services rows; with no DONE pressed yet there's
    // no row to repoint, so turn credit was stuck on Kayla.
    {
      const visitId = ticket.queueEntryId;
      if (visitId) {
        for (const l of lines) {
          if (l.kind !== 'service' || !l.existingId) continue;
          const orig = originalStaffByItemId.get(l.existingId);
          if (!orig) continue;
          if (orig.staff1Id === l.staff1Id) continue;          // staff unchanged
          const svcName = (l.name ?? orig.name ?? '').trim();
          if (!svcName) continue;

          // 1. Strip the service from the OLD staff's queue_entry.
          if (orig.staff1Id) {
            const oldEntry = state.queue.find(
              (q) =>
                getVisitId(q.parentQueueId ?? q.id) === visitId &&
                q.assignedManicuristId === orig.staff1Id,
            );
            if (oldEntry) {
              const idx = oldEntry.services.indexOf(svcName as ServiceType);
              if (idx !== -1) {
                const remaining = [...oldEntry.services];
                remaining.splice(idx, 1);
                if (remaining.length === 0) {
                  // Old staff had this as her only service on this visit —
                  // delete the queue_entry and free her card.
                  const credit = Number(oldEntry.turnValue) || 0;
                  if (credit > 0 && oldEntry.assignedManicuristId) {
                    const m = state.manicurists.find((mm) => mm.id === oldEntry.assignedManicuristId);
                    if (m) {
                      dispatch({
                        type: 'UPDATE_MANICURIST',
                        id: m.id,
                        updates: {
                          totalTurns: Math.max(0, (m.totalTurns || 0) - credit),
                          status: m.currentClient === oldEntry.id ? 'available' : m.status,
                          currentClient: m.currentClient === oldEntry.id ? null : m.currentClient,
                        },
                      });
                    }
                  }
                  dispatch({ type: 'REMOVE_CLIENT', id: oldEntry.id });
                } else {
                  const newTurnValue = remaining.reduce((sum, sv) => {
                    const cat = state.salonServices.find((s) => s.name === sv);
                    return sum + Number(cat?.turnValue ?? 0);
                  }, 0);
                  dispatch({
                    type: 'UPDATE_CLIENT',
                    id: oldEntry.id,
                    updates: { services: remaining, turnValue: newTurnValue },
                  });
                }
              }
            }
          }

          // 2. Add the service to the NEW staff's queue_entry, or create one.
          if (l.staff1Id) {
            const newEntry = state.queue.find(
              (q) =>
                getVisitId(q.parentQueueId ?? q.id) === visitId &&
                q.assignedManicuristId === l.staff1Id,
            );
            if (newEntry) {
              if (!newEntry.services.includes(svcName as ServiceType)) {
                const next = [...newEntry.services, svcName as ServiceType];
                const newTurnValue = next.reduce((sum, sv) => {
                  const cat = state.salonServices.find((s) => s.name === sv);
                  return sum + Number(cat?.turnValue ?? 0);
                }, 0);
                dispatch({
                  type: 'UPDATE_CLIENT',
                  id: newEntry.id,
                  updates: { services: next as ServiceType[], turnValue: newTurnValue },
                });
              }
              // Flip the new staff's card to busy + point at this entry.
              dispatch({
                type: 'UPDATE_MANICURIST',
                id: l.staff1Id,
                updates: { status: 'busy', currentClient: newEntry.id },
              });
            } else {
              // No existing queue entry for new staff — create an add-child
              // AND explicitly credit the turn. ADD_CLIENT doesn't touch
              // totalTurns (turn credits normally come from COMPLETE_SERVICE
              // or the cashier-add-line credit block at checkout), so without
              // this UPDATE_MANICURIST the swap leaves the new staff missing
              // her credit even though the old staff lost hers. Symptom:
              // ticket #15 swap moved Gel Pedicure to Z-TEST 3 but only the
              // dropdown text changed — old staff's turns went down, Z-TEST 3's
              // didn't go up.
              const addChildId = `${visitId}-add-${l.staff1Id}`;
              const cat = state.salonServices.find((s) => s.name === svcName);
              const turnValueForSvc = Number(cat?.turnValue ?? 0);
              const now = Date.now();
              dispatch({
                type: 'ADD_CLIENT',
                client: {
                  id: addChildId,
                  parentQueueId: visitId,
                  clientName: clientName || ticket.clientName || 'Walk-in',
                  services: [svcName as ServiceType],
                  turnValue: turnValueForSvc,
                  serviceRequests: [],
                  requestedManicuristId: null,
                  isRequested: false,
                  isAppointment: false,
                  assignedManicuristId: l.staff1Id,
                  status: 'inProgress',
                  arrivedAt: now,
                  startedAt: now,
                  completedAt: null,
                  extraTimeMs: 0,
                },
              });
              const newStaff = state.manicurists.find((m) => m.id === l.staff1Id);
              if (newStaff) {
                dispatch({
                  type: 'UPDATE_MANICURIST',
                  id: l.staff1Id,
                  updates: {
                    status: 'busy',
                    currentClient: addChildId,
                    totalTurns: Math.max(0, (newStaff.totalTurns || 0) + turnValueForSvc),
                  },
                });
              }
            }
          }
        }
      }
    }

    // Service-edit sync: reconcile each touched visit's completed_services row
    // against the FINAL line state in the ticket. This is intentionally a
    // reconciliation pass (rebuild from current lines) rather than a diff
    // (compare to originalStaffByItemId) — the diff approach only catches
    // renames of EXISTING lines and silently drops two common edit shapes:
    //   1. Delete the old line + add a new one from the catalog dropdown
    //      (the natural way receptionists "change a service" in the UI).
    //   2. Add an extra line for an additional service performed during
    //      checkout.
    // Reconciling per-visit fixes all four shapes uniformly: rename,
    // R-toggle, removal, addition.
    //
    // Visit attribution is resilient to lines that lack a queue_entry_id
    // (legacy items, manually-added catalog lines): we collect candidate
    // visits from BOTH the original ticket items AND the current lines, and
    // when the ticket touches exactly one visit (the common single-visit
    // case) every service line is attributed to that visit. For multi-visit
    // tickets, lines with their own queue_entry_id map directly; orphaned
    // new lines fall back to staff1Id matching across the candidate set.
    //
    // Turn-value math (mirrors MultiServiceAssign):
    //   - non-request service     => contributes its full catalog turnValue
    //   - client-requested service => contributes 1 if Combo, 0.5 otherwise
    // We bypass dispatch UPDATE_COMPLETED + reducer + trackSave because the
    // ticket_items write above sets isApplyingRemoteRef.current and the sync
    // effect would skip the completed_services flush. Writing directly to
    // Supabase ensures the change lands; realtime then echoes back into
    // state.completed via REMOTE_COMPLETED_UPSERT for the UI.

    function visitIdOf(qid: string | null | undefined): string | null {
      if (!qid) return null;
      return qid.includes('#') ? qid.split('#')[0] : qid;
    }

    // Collect every visit ID this ticket might touch, from the original
    // items + the current lines + the ticket header. Then resolve each to
    // an actual state.completed entry. If a candidate id doesn't resolve
    // directly (e.g. ticket.queueEntryId is the parent UUID of a SPLIT
    // visit while completed_services has child rows), also accept any
    // entry whose id starts with the candidate — that gathers the children.
    const candidateIds = new Set<string>();
    for (const orig of originalStaffByItemId.values()) {
      const v = visitIdOf(orig.queueEntryId);
      if (v) candidateIds.add(v);
    }
    for (const l of lines) {
      if (l.kind !== 'service') continue;
      const v = visitIdOf(l.queueEntryId);
      if (v) candidateIds.add(v);
    }
    const ticketVisit = visitIdOf(ticket.queueEntryId);
    if (ticketVisit) candidateIds.add(ticketVisit);

    type CandidateEntry = (typeof state.completed)[number];
    const candidateEntries: CandidateEntry[] = [];
    const seenEntryIds = new Set<string>();
    for (const cid of candidateIds) {
      for (const e of state.completed) {
        if (seenEntryIds.has(e.id)) continue;
        if (e.id === cid || e.id.startsWith(`${cid}-`)) {
          candidateEntries.push(e);
          seenEntryIds.add(e.id);
        }
      }
    }

    type Bucket = { entry: CandidateEntry; services: ServiceType[]; requested: ServiceType[] };
    const bucketByEntry = new Map<string, Bucket>();
    for (const e of candidateEntries) {
      bucketByEntry.set(e.id, { entry: e, services: [], requested: [] });
    }

    // Attribute each surviving service line to one bucket.
    for (const l of lines) {
      if (l.kind !== 'service') continue;
      const name = l.name.trim();
      if (!name) continue;

      let target: Bucket | undefined;
      const lineVisit = visitIdOf(l.queueEntryId);
      if (lineVisit && bucketByEntry.has(lineVisit)) {
        target = bucketByEntry.get(lineVisit);
      } else if (
        candidateEntries.length === 1 &&
        (!l.staff1Id || candidateEntries[0].manicuristId === l.staff1Id)
      ) {
        // Single-visit ticket AND this line's staff matches the only
        // completed entry's manicurist (or the line has no staff — legacy /
        // manual-add path): safe to attribute every line to that one bucket.
        //
        // CRITICAL: the staff-match guard is what keeps a multi-staff visit
        // from welding sibling staff's services into the first manicurist's
        // history row. Pre-2026-05-28 this branch attributed EVERY ticket
        // line to the single candidate regardless of staff. When a multi-
        // staff visit had only ONE staff DONE'd so far (very common — staff
        // finish at different times), candidateEntries.length was still 1,
        // every ticket line — including the other staff's lines — got
        // pushed into the first staff's bucket, and the UPDATE below wrote
        // `services = [all staff's services]` and `turn_value = sum of all
        // base turns` to that one row. Hit Rebecca/Macy (turn=5), Janice/
        // Kimberly (turn=3, services welded), Tiffany 3/Macy (turn=2)
        // 2026-05-27. Now lines whose staff differs from the single
        // candidate fall through to the staff-match branch below (or end
        // up handled as a new-staff auto-credit later in doSave).
        target = bucketByEntry.get(candidateEntries[0].id);
      } else if (l.staff1Id) {
        // Multi-visit ticket with a line that lacks its own visit binding —
        // best-effort match by staff. Picks the first candidate whose
        // manicurist matches; if several do, this collapses them onto the
        // earliest. Acceptable for the rare manual-add-after-split path.
        target = candidateEntries
          .map((e) => bucketByEntry.get(e.id))
          .find((b): b is Bucket => !!b && b.entry.manicuristId === l.staff1Id);
      }
      if (!target) continue;
      target.services.push(name as ServiceType);
      if (l.isRequested) target.requested.push(name as ServiceType);
    }

    // Stable string key for shallow array equality — services/requested are
    // order-sensitive in the reducer, so we DON'T sort here.
    const arrKey = (a: readonly string[]) => JSON.stringify(a);

    for (const [, bucket] of bucketByEntry) {
      const { entry, services: newServices, requested: newRequested } = bucket;
      // Don't blank out a row if every line for this visit was trashed —
      // that's almost certainly a mid-edit mistake. Use History → Void to
      // wipe a visit intentionally.
      if (newServices.length === 0) continue;
      const sameServices = arrKey(entry.services) === arrKey(newServices);
      const sameRequested =
        arrKey(entry.requestedServices ?? []) === arrKey(newRequested);
      if (sameServices && sameRequested) continue;

      const newTurnValue = newServices.reduce((sum, name) => {
        const svc = state.salonServices.find((s) => s.name === name);
        const base = svc?.turnValue ?? 0;
        if (base === 0) return sum;
        if (newRequested.includes(name)) {
          return sum + (svc?.category === 'Combo' ? 1 : 0.5);
        }
        return sum + base;
      }, 0);

      const turnDelta = newTurnValue - entry.turnValue;
      // Mirror the per-manicurist totalTurns delta into LOCAL state so
      // syncManicurists doesn't race the DB-side update below. Without
      // this dispatch, any unrelated UPDATE_MANICURIST that fires between
      // now and the realtime echo can upload stale total_turns and
      // overwrite the credit we just wrote to DB.
      if (turnDelta !== 0 && entry.manicuristId) {
        const eMid = entry.manicuristId;
        const localCur = Number(
          state.manicurists.find((mm) => mm.id === eMid)?.totalTurns ?? 0,
        );
        dispatch({
          type: 'UPDATE_MANICURIST',
          id: eMid,
          updates: { totalTurns: Math.max(0, localCur + turnDelta) },
        });
      }

      void (async () => {
        const { error } = await supabase.from('completed_services').update({
          services: newServices,
          service: newServices[0] ?? '',
          requested_services: newRequested,
          turn_value: newTurnValue,
          is_requested: newRequested.length > 0,
          edited: true,
        }).eq('id', entry.id);
        if (error) {
          console.error('[ticket modal] completed_services sync failed:', error.message);
          return;
        }
        // Adjust the manicurist's totalTurns by the same delta so the queue
        // card / staff portal reflect the new credit. Uses applyTurnDelta
        // (compare-and-swap) so a concurrent writer — another tab's bucket
        // recompute, a voidTicket rollback echo, syncManicurists — can't
        // silently clobber this update with a stale snapshot.
        // (2026-05-31 audit N31-H2)
        if (turnDelta !== 0 && entry.manicuristId) {
          await applyTurnDelta(entry.manicuristId, turnDelta);
        }
      })();
    }

    // Credit turns for service lines added during checkout for a staff who
    // isn't already part of the visit's completed_services buckets. The
    // bucket recompute above handles additions for staff who ARE part of
    // the visit (their bucket gets the new service + recomputed turn
    // value with delta applied). For a brand-new staff on this visit
    // (Kayla added by the cashier even though she wasn't in the queue
    // for this client), no bucket exists, so we credit the catalog turn
    // value directly and persist a fresh completed_services row so
    // History reflects the work.
    const bucketStaffIds = new Set<string>();
    for (const [, bucket] of bucketByEntry) {
      if (bucket.entry.manicuristId) bucketStaffIds.add(bucket.entry.manicuristId);
    }
    const visitForAdds = ticketVisit ?? (candidateEntries[0]?.id ? visitIdOf(candidateEntries[0].id) : null);
    for (const l of lines) {
      if (l.kind !== 'service') continue;
      // Existing lines were credited at the original assignment time.
      if (l.existingId) continue;
      if (!l.staff1Id || !l.name.trim()) continue;
      // If this staff already has a bucket, the recompute above already
      // adjusted their total_turns by the correct delta.
      if (bucketStaffIds.has(l.staff1Id)) continue;
      const svc = state.salonServices.find((s) => s.name === l.name.trim());
      const baseTurns = Number(svc?.turnValue ?? 0);
      if (baseTurns <= 0) continue;
      // Mirror the request-half-credit rule used in MultiServiceAssign and
      // the bucket recompute: a requested service for a specific staff
      // earns Combo=1 / non-Combo=0.5; otherwise it earns the full
      // catalog turnValue.
      const turnValue = l.isRequested
        ? (svc?.category === 'Combo' ? 1 : 0.5)
        : baseTurns;
      // Use the SAME deterministic id as the synthetic add-child queue
      // entry created by ensureManicuristBusyForAddedLine
      // (`${visit}-add-${staff}`). When the manicurist later hits DONE,
      // the reducer's COMPLETE_SERVICE writes a completed_services row
      // keyed on the queue entry's id; if we use a timestamp-suffixed id
      // here, that later write inserts a SECOND row for the same
      // (visit, staff, service) and History double-counts the turn.
      // Symptom: Lauren × Tommy × Manicure showed twice in History on
      // ticket #32, 2026-05-21.
      const newEntryId = visitForAdds
        ? `${visitForAdds}-add-${l.staff1Id}`
        : `${ticket.id}-add-${l.staff1Id}`;
      // If a row with this id already exists in local state, the turn has
      // already been credited (either by a prior Save whose realtime echo
      // has landed, or by a COMPLETE_SERVICE that beat this save). Skip
      // to avoid double-incrementing the manicurist's total_turns.
      if (state.completed.some((c) => c.id === newEntryId)) continue;
      const nowIso = new Date().toISOString();

      // Dispatch the turn credit LOCALLY first so state.manicurists reflects
      // the new total before the async DB writes happen. Without this, the
      // direct supabase update below races with syncManicurists (which
      // uploads the local manicurist row whenever it changes for an
      // unrelated reason). The local-then-DB ordering keeps both sides
      // converged on the correct total even if the realtime echo arrives
      // late, and the card shows the credited turn immediately instead of
      // waiting for a round-trip.
      const lStaffId = l.staff1Id;
      const localCurrentTurns = Number(
        state.manicurists.find((mm) => mm.id === lStaffId)?.totalTurns ?? 0,
      );
      dispatch({
        type: 'UPDATE_MANICURIST',
        id: lStaffId,
        updates: { totalTurns: localCurrentTurns + turnValue },
      });

      void (async () => {
        // Upsert (ignoring duplicates) a completed_services row so reports
        // and History reflect this manually-added work. We use upsert with
        // ignoreDuplicates rather than insert so a duplicate PK from a
        // rapid double-Save (before the realtime echo has updated
        // state.completed) is a harmless no-op instead of an error log.
        // Subsequent saves take the existingId / state.completed early-exit
        // branches and don't reach this code.
        const { error: csErr } = await supabase.from('completed_services').upsert({
          id: newEntryId,
          client_name: clientName || ticket.clientName || 'Walk-in',
          manicurist_id: l.staff1Id,
          manicurist_name: l.staff1Name,
          manicurist_color: l.staff1Color,
          service: l.name,
          services: [l.name],
          requested_services: l.isRequested ? [l.name] : [],
          turn_value: turnValue,
          is_appointment: false,
          is_requested: !!l.isRequested,
          edited: true,
          voided: false,
          started_at: nowIso,
          completed_at: nowIso,
        }, { onConflict: 'id', ignoreDuplicates: true });
        if (csErr) {
          console.error('[ticket modal] completed_services upsert for added line failed:', csErr.message);
          // The completed_services row is best-effort for reports — fall
          // through and still attempt the turn credit so the cashier
          // doesn't lose the count on a schema mismatch / RLS edge case.
        }
        // Write the EXACT post-dispatch value, not (current + turnValue).
        // syncManicurists may have already uploaded localCurrentTurns +
        // turnValue by the time this runs, so re-fetching and adding
        // turnValue again double-credits. The dispatch above and this
        // write must converge on the same value: localCurrentTurns +
        // turnValue. Idempotent if syncManicurists fires in between.
        //
        // ERROR HANDLING: if this write fails (network blip, RLS denial,
        // anything), the local dispatch above already credited the turn so
        // the UI shows it — but the DB does not. On next reload or realtime
        // echo the credit would vanish and the cashier would think the app
        // ate it. We compensate by dispatching a matching subtract back off
        // localCurrentTurns + turnValue → localCurrentTurns (the value we
        // captured before the dispatch), and surface a setError so the
        // cashier knows to retry. The setError is the same mechanism used
        // by the rest of handleSave for save-level errors.
        const { error: mUpErr } = await supabase
          .from('manicurists')
          .update({ total_turns: localCurrentTurns + turnValue })
          .eq('id', lStaffId);
        if (mUpErr) {
          console.error(
            '[ticket modal] manicurists turn write for added line failed:',
            mUpErr.message,
          );
          dispatch({
            type: 'UPDATE_MANICURIST',
            id: lStaffId,
            updates: { totalTurns: localCurrentTurns },
          });
          setError(
            `Couldn't credit ${l.staff1Name ?? 'manicurist'}'s turn — check connection and retry.`,
          );
        }
      })();
    }

    onChanged?.(saved);
    return saved;
  }

  // ─── Process Ticket ───────────────────────────────────────────────────────
  async function handleProcess() {
    setError(null);
    if (lines.length === 0) { setError('Add at least one item.'); return; }
    // Block checkout if any service line is still unassigned. Cashier needs
    // to know who to credit before money changes hands.
    const unassignedServices = lines.filter((l) => l.kind === 'service' && !l.staff1Id);
    if (unassignedServices.length > 0) {
      const names = unassignedServices.map((l) => l.name).join(', ');
      setError(`Assign a manicurist to: ${names}`);
      return;
    }
    // Zero-balance tickets (fully discounted / comped) can be processed
    // without a payment row — skip the "add a payment" guard when the total
    // is $0. The amount-match check below naturally passes (0 === 0).
    if (totalCents > 0 && pending.length === 0) { setError('Add a payment first.'); return; }
    if (Math.abs(pendingPaidCents - totalCents) > 0) {
      setError(`Payments ${formatMoneyCents(pendingPaidCents)} ≠ total ${formatMoneyCents(totalCents)}.`);
      return;
    }
    // Block an over-balance gift redemption before anything is committed.
    setBusy('processing');
    const giftErr = await giftOverdraftError();
    if (giftErr) { setBusy('idle'); setError(giftErr); return; }
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
    // Flip the linked appointment (if any) to 'completed' so the appointment
    // book turns the block dark gray. Per user request 2026-05-22, this is
    // the ONLY place that flips appt → 'completed' — COMPLETE_SERVICE leaves
    // it alone so the block stays light gray until payment is processed.
    //
    // Lookup strategy (refresh-safe):
    //   1. Direct id link via state.completed[].originalAppointmentId. This
    //      only works in the same session before refresh because the field
    //      is not persisted to the DB.
    //   2. Fallback: name match against today's appts. Same defensive
    //      heuristic used by awaitingPaymentApptIds in AppointmentBookView.
    //      This is what makes self-darken survive page refreshes.
    {
      // Darken the linked appointment block by EXACT appointment id only —
      // never by client name. The authoritative path is now the DB trigger
      // `tickets_complete_appointment_on_close`, which flips the appointment by
      // its id when this ticket closes (works on every device, survives
      // refresh). This client dispatch is just instant local feedback on the
      // paying device. The ticket's appointment_id is kept reliably populated by
      // the continuous backfill in syncQueue.
      //
      // The old name-match fallback was removed deliberately: when two same-name
      // clients shared a tech (e.g. a mother and daughter booked under one name,
      // same service, same manicurist) it darkened BOTH blocks on a single
      // payment. Keying strictly by id darkens only the booking that was paid.
      const apptIdsToComplete = new Set<string>();
      if (ticket.appointmentId) {
        apptIdsToComplete.add(ticket.appointmentId);
      }
      if (ticket.queueEntryId) {
        const completedRow = state.completed.find((c) => c.id === ticket.queueEntryId);
        if (completedRow?.originalAppointmentId) {
          apptIdsToComplete.add(completedRow.originalAppointmentId);
        }
      }
      for (const id of apptIdsToComplete) {
        dispatch({
          type: 'UPDATE_APPOINTMENT',
          id,
          updates: { status: 'completed' },
        });
      }
    }
    // Auto-finalize: any manicurist still pointing at this visit needs to be
    // FINALIZED (turn credit + completed_services row), not just cleared.
    //
    // Pre-2026-05-27 this branch only flipped state.manicurists to
    // available, which is why every closed ticket where the manicurist
    // never pressed DONE silently lost its history row + turn credit when
    // the auto-sync trigger recomputed total_turns from a history that was
    // missing the entry. That bug ate Brian/Christina/Joe/Katelyn/Macy/
    // Tammy/Tommy's numbers on 2026-05-27.
    //
    // Three cases on m.currentClient:
    //   - `${visitId}` (bare primary) or a split-and-assign child
    //     (`${visitId}-mani-…` / `${visitId}-waiting-…`): dispatch
    //     COMPLETE_SERVICE so the reducer writes a proper history row
    //     using the queue entry's deterministic id + real turnValue.
    //     COMPLETE_SERVICE is idempotent at the PK layer, so if the
    //     manicurist later presses DONE manually the second write is a
    //     no-op instead of a duplicate.
    //   - `${visitId}-add-…` (cashier-added synthetic add-child): the
    //     ticket_items are owned by the cashier's TicketModal save and
    //     the synthetic queue entry carries turnValue=0, so a
    //     COMPLETE_SERVICE would just emit a turn=0 noise row. Keep the
    //     lightweight UPDATE_MANICURIST + REMOVE_CLIENT cleanup —
    //     without it the add-child sits in state.queue forever and the
    //     manicurist panel keeps drawing a phantom BUSY card.
    //   - anything else: leave the manicurist alone.
    if (ticket.queueEntryId) {
      const visitId = ticket.queueEntryId;
      const addChildPrefix = `${visitId}-add-`;
      const splitPrefixes = [`${visitId}-mani-`, `${visitId}-waiting-`];
      for (const m of state.manicurists) {
        if (!m.currentClient) continue;
        const cc = m.currentClient;
        if (cc.startsWith(addChildPrefix)) {
          dispatch({
            type: 'UPDATE_MANICURIST',
            id: m.id,
            updates: { status: 'available', currentClient: null },
          });
        } else if (
          cc === visitId ||
          splitPrefixes.some((p) => cc.startsWith(p))
        ) {
          dispatch({ type: 'COMPLETE_SERVICE', manicuristId: m.id });
        }
      }
      for (const q of state.queue) {
        if (q.id.startsWith(addChildPrefix)) {
          dispatch({ type: 'REMOVE_CLIENT', id: q.id });
        }
      }
    } else {
      // No queueEntryId — this is a manual "+ NEW TICKET" ticket the cashier
      // created at the register without a queue linkage. Find any BUSY
      // manicurist whose currentClient is a queue entry matching THIS
      // ticket's client name AND whose own id matches one of the ticket's
      // service-line staff, then:
      //
      //   1. Stamp the closed ticket's queue_entry_id with that visit's id
      //      (parentQueueId if split, else the entry id). This is what
      //      lets a subsequent reconcileMissingTicketsForDate pass see the
      //      linkage and skip creating a phantom open duplicate — the
      //      Taylor #35→#36 / Addison #6→#27 bug, 2026-05-27.
      //
      //   2. Dispatch COMPLETE_SERVICE for each matching manicurist so
      //      they finalize like they would have on a manual DONE press:
      //      turn credit recorded, removed from queue, card back to
      //      AVAILABLE. The salon's "safety net for manicurists who
      //      forget to press DONE before checkout."
      //
      // Match conditions are intentionally narrow to avoid finalizing an
      // unrelated visit: the manicurist must currently be BUSY with a
      // queue entry whose clientName equals the ticket's clientName AND
      // whose manicurist appears as one of the staff on the ticket. A
      // BUSY manicurist on a different client is left alone.
      const normName = (v: string | null | undefined) =>
        (v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
      const ticketClient = normName(ticket.clientName);
      if (ticketClient) {
        const ticketStaffIds = new Set<string>();
        for (const it of ticket.items ?? []) {
          if (it.staff1Id) ticketStaffIds.add(it.staff1Id);
          if (it.staff2Id) ticketStaffIds.add(it.staff2Id);
        }
        // Walk the manicurist roster; for each BUSY one whose
        // currentClient is a queue entry matching the ticket's client,
        // gather them up so we can backfill once and dispatch once per
        // manicurist below.
        const matchedManicuristIds = new Set<string>();
        let backfillVisitId: string | null = null;
        let backfillStaff: { id: string; name: string; color: string } | null = null;
        for (const m of state.manicurists) {
          if (m.status !== 'busy' || !m.currentClient) continue;
          if (ticketStaffIds.size > 0 && !ticketStaffIds.has(m.id)) continue;
          const qe = state.queue.find((q) => q.id === m.currentClient);
          if (!qe) continue;
          if (normName(qe.clientName) !== ticketClient) continue;
          matchedManicuristIds.add(m.id);
          if (!backfillVisitId) {
            backfillVisitId = qe.parentQueueId ?? qe.id;
            backfillStaff = { id: m.id, name: m.name, color: m.color };
          }
        }
        if (backfillVisitId && backfillStaff) {
          // Fire-and-await the DB update so the next reconcile pass sees
          // the linkage. We don't bail on failure — the COMPLETE_SERVICE
          // dispatches still need to run so the manicurist's card resets
          // even if the DB link races with something else.
          await linkClosedTicketToVisit(ticket.id, backfillVisitId, backfillStaff);
        }
        for (const mid of matchedManicuristIds) {
          dispatch({ type: 'COMPLETE_SERVICE', manicuristId: mid });
        }
      }
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
    if (ok) {
      if (ticket.queueEntryId) {
        const visitId = ticket.queueEntryId;
        const addChildPrefix = `${visitId}-add-`;
        for (const m of state.manicurists) {
          if (
            m.currentClient === visitId ||
            (m.currentClient && m.currentClient.startsWith(addChildPrefix))
          ) {
            dispatch({
              type: 'UPDATE_MANICURIST',
              id: m.id,
              updates: { status: 'available', currentClient: null },
            });
          }
        }
        // Wipe EVERY queue entry tied to this visit so the manicurist's
        // card can't show a stale "in service" state and pressing DONE
        // later can't sneak a completed_services row past the void's
        // turn-refund pass. Three kinds of entries are linked to a visit:
        //   1. main visit entry: q.id === visitId
        //   2. SPLIT_AND_ASSIGN children: q.parentQueueId === visitId
        //   3. ad-hoc "add-line" synth children: q.id starts with
        //      `${visitId}-add-` (also covered by the addChildPrefix below)
        // Without this, voiding an open ticket while a service is still
        // in progress let the manicurist complete the service ~minutes
        // later, which created a new completed_services row that the
        // void's earlier rollback pass had already missed - the turn
        // credit was effectively un-refundable (see Victoria 2026-05-24).
        for (const q of state.queue) {
          if (
            q.id === visitId ||
            q.parentQueueId === visitId ||
            q.id.startsWith(addChildPrefix)
          ) {
            dispatch({ type: 'REMOVE_CLIENT', id: q.id });
          }
        }
        // Walk-in cleanup: collect every appt id linked to this visit's
        // queue entries (in-progress walk-ins) and completed_services
        // entries (completed walk-ins). Delete any that are still flagged
        // appt.isWalkIn === true — those are auto-placed blocks the
        // receptionist hasn't drag-confirmed. Drag-confirmed blocks stay
        // (they've become "real" appointments and survive the void).
        const walkInApptIds = new Set<string>();
        for (const q of state.queue) {
          if ((q.id === visitId || q.parentQueueId === visitId) && q.originalAppointment?.id) {
            walkInApptIds.add(q.originalAppointment.id);
          }
        }
        for (const c of state.completed) {
          if ((c.id === visitId || c.id.startsWith(`${visitId}-`)) && c.originalAppointmentId) {
            walkInApptIds.add(c.originalAppointmentId);
          }
        }
        for (const apptId of walkInApptIds) {
          const appt = state.appointments.find((a) => a.id === apptId);
          if (appt && appt.isWalkIn) {
            dispatch({ type: 'DELETE_APPOINTMENT', id: apptId });
          }
        }
      }
      onClose();
    }
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
        <div className="px-5 py-2.5 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-baseline gap-3">
            <h2 className="font-bebas text-2xl tracking-widest text-gray-900">CHECK OUT TICKET</h2>
            <span className="font-mono text-xs text-gray-600">#{ticket.ticketNumber}</span>
            <span className="font-mono text-xs text-gray-600">{formatBusinessDate(ticket.businessDate)}</span>
            {ticket.status === 'closed' && (
              <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-mono text-xs font-bold tracking-wider">CLOSED</span>
            )}
            {unlockedForEdit && (
              <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-mono text-xs font-bold tracking-wider">EDITING</span>
            )}
            {isVoided && (
              <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-mono text-xs font-bold tracking-wider">VOID</span>
            )}
            {isOpen && (
              <span className="px-2 py-0.5 rounded-full bg-pink-100 text-pink-600 font-mono text-xs font-bold tracking-wider">OPEN</span>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-600 hover:text-gray-900">
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
                    disabled={!canEdit}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-gray-300 font-mono text-sm text-gray-900 placeholder-gray-500 focus:outline-none focus:border-gray-500 disabled:bg-gray-100 disabled:text-gray-700"
                    placeholder="Walk-in"
                  />
                </Field>
                <Field label="Last Name">
                  <input
                    type="text" value={clientLastName} onChange={(e) => setClientLastName(e.target.value)}
                    disabled={!canEdit}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-gray-300 font-mono text-sm text-gray-900 placeholder-gray-500 focus:outline-none focus:border-gray-500 disabled:bg-gray-100 disabled:text-gray-700"
                    placeholder="—"
                  />
                </Field>
                <Field label="Phone">
                  <input
                    type="tel" value={clientPhone} onChange={(e) => setClientPhone(e.target.value)}
                    disabled={!canEdit}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-gray-300 font-mono text-sm text-gray-900 placeholder-gray-500 focus:outline-none focus:border-gray-500 disabled:bg-gray-100 disabled:text-gray-700"
                    placeholder="(555) 555-5555"
                  />
                </Field>
                <Field label="Primary Staff">
                  <select
                    value={primaryManicuristId ?? ''}
                    onChange={(e) => setPrimaryManicuristId(e.target.value || null)}
                    disabled={!canEdit}
                    className="w-full px-2.5 py-1.5 rounded-lg border border-gray-300 font-mono text-sm text-gray-900 placeholder-gray-500 focus:outline-none focus:border-gray-500 disabled:bg-gray-100 disabled:text-gray-700"
                  >
                    <option value="">—</option>
                    {manicurists.map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                </Field>
              </div>

              {/* Line items grid — scrolls inside if needed so the rest stays in view */}
              <div className="border border-gray-200 rounded-xl overflow-hidden flex flex-col min-h-0">
                <div className="grid grid-cols-[46px_60px_1fr_130px_90px_90px_36px_30px] gap-2 px-3 py-1.5 bg-gray-100 border-b border-gray-200 text-[11px] tracking-wider font-mono font-semibold text-gray-700 uppercase">
                  <span className="text-center">#</span>
                  <span className="text-center">Qty</span>
                  <span>Service</span>
                  <span>Staff</span>
                  <span className="text-right">Price</span>
                  <span className="text-right">Ext</span>
                  <span className="text-center">R</span>
                  <span></span>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto">
                  {lines.length === 0 ? (
                    <div className="px-3 py-4 text-center font-mono text-xs text-gray-600">
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
                          className="grid grid-cols-[46px_60px_1fr_130px_90px_90px_36px_30px] gap-2 items-center px-3 py-1 border-b border-gray-100 last:border-b-0"
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
                            disabled={!canEdit}
                            className="px-1.5 py-1 rounded-md border border-transparent text-gray-900 hover:border-gray-300 focus:border-gray-500 font-mono text-sm text-center focus:outline-none disabled:bg-gray-100 disabled:text-gray-700"
                          />
                          {/* Service name + per-line SWAP dropdown.
                              The dropdown is grouped by category via
                              <optgroup> so the long flat list of every salon
                              service is digestible. Picking a service here
                              UPDATEs the line in-place (no delete + insert),
                              so it's the safe way to swap an existing line's
                              service — the queue_entry name sync block in
                              doSave then mirrors the change to the queue
                              entry's services array. The "+ Add line" /
                              category-picker flow at the top of the modal
                              is for ADDING new lines, not swapping. */}
                          <div className="flex items-center gap-1 min-w-0">
                            <input
                              type="text" value={line.name}
                              onChange={(e) => updateLine(idx, { name: e.target.value })}
                              disabled={!canEdit}
                              placeholder="Service name"
                              className="flex-1 min-w-0 px-1.5 py-1 rounded-md border border-transparent text-gray-900 hover:border-gray-300 focus:border-gray-500 font-mono text-sm focus:outline-none disabled:bg-gray-100 disabled:text-gray-700"
                            />
                            {line.kind === 'service' && (
                              <select
                                value=""
                                onChange={(e) => {
                                  const svc = sortedServices.find((s) => s.id === e.target.value);
                                  if (!svc) return;
                                  updateLine(idx, {
                                    serviceId: svc.id,
                                    name: svc.name,
                                    priceInput: svc.price.toFixed(2),
                                  });
                                }}
                                disabled={!canEdit}
                                title="Swap to a different service"
                                aria-label="Swap service"
                                className="w-6 px-0 py-1 rounded-md border border-transparent text-gray-400 hover:border-gray-300 hover:text-gray-700 font-mono text-xs focus:outline-none cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                              >
                                <option value=""></option>
                                {availableCategories.map((cat) => (
                                  <optgroup key={cat} label={cat}>
                                    {sortedServices
                                      .filter((s) => s.category === cat)
                                      .map((s) => (
                                        <option key={s.id} value={s.id}>{s.name}</option>
                                      ))}
                                  </optgroup>
                                ))}
                              </select>
                            )}
                          </div>
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
                            disabled={!canEdit}
                            className="px-1.5 py-1 rounded-md border border-transparent text-gray-900 hover:border-gray-300 focus:border-gray-500 font-mono text-sm focus:outline-none disabled:bg-gray-100 disabled:text-gray-700"
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
                            disabled={!canEdit}
                            className="px-1.5 py-1 rounded-md border border-transparent text-gray-900 hover:border-gray-300 focus:border-gray-500 font-mono text-sm text-right focus:outline-none disabled:bg-gray-100 disabled:text-gray-700"
                          />
                          <span className="px-1.5 py-1 font-mono text-sm font-semibold text-gray-900 text-right">
                            {formatMoneyCents(ext)}
                          </span>
                          {isService ? (
                            <button
                              type="button"
                              onClick={() => updateLine(idx, { isRequested: !line.isRequested })}
                              disabled={!canEdit}
                              title={line.isRequested ? 'Client request \u2014 click to clear' : 'Mark as client request'}
                              className={`justify-self-center w-7 h-7 rounded-full text-xs font-bold transition-colors ${
                                line.isRequested
                                  ? 'bg-red-500 text-white border-2 border-red-500 hover:bg-red-600'
                                  : 'bg-white text-gray-500 border-2 border-gray-300 hover:border-red-400 hover:text-red-500'
                              } disabled:opacity-50 disabled:cursor-not-allowed`}
                            >
                              R
                            </button>
                          ) : <span />}
                          {canEdit ? (
                            <button onClick={() => removeLine(idx)}
                              className="p-1 rounded-lg text-gray-500 hover:text-red-600 hover:bg-red-50 transition-colors">
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
                {canEdit && (
                  <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-2 items-center px-3 py-1.5 bg-gray-100 border-t border-gray-200">
                    <select
                      value={pickerCategory}
                      onChange={(e) => {
                        setPickerCategory(e.target.value);
                        setPickerServiceId('');
                      }}
                      className="px-2 py-1.5 rounded-md border border-gray-300 font-mono text-sm text-gray-900 bg-white focus:outline-none focus:border-gray-500"
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
                      className="px-2 py-1.5 rounded-md border border-gray-300 font-mono text-sm text-gray-900 bg-white focus:outline-none focus:border-gray-500 disabled:bg-gray-100 disabled:text-gray-500 disabled:cursor-not-allowed"
                    >
                      <option value="">Service…</option>
                      {servicesInCategory.map((s) => (
                        <option key={s.id} value={s.id}>{s.name} — ${s.price.toFixed(2)}</option>
                      ))}
                    </select>
                    <button onClick={addBlankCustomLine}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-gray-300 text-gray-800 hover:bg-white font-mono text-xs font-semibold transition-colors">
                      <Plus size={14} /> CUSTOM
                    </button>
                    <button onClick={() => { void openGiftModal(); }}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-pink-300 bg-pink-50 text-pink-800 hover:bg-pink-100 hover:border-pink-400 font-mono text-xs font-semibold transition-colors">
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
                    disabled={!canEdit}
                    className="flex-1 px-2.5 py-1.5 rounded-lg border border-gray-300 font-mono text-sm text-gray-900 placeholder-gray-500 focus:outline-none focus:border-gray-500 disabled:bg-gray-100"
                    placeholder="Note…"
                  />
                  {canEdit && !note && (
                    <button onClick={() => setShowNote(false)}
                      className="px-2 py-1.5 rounded-lg text-gray-600 hover:text-gray-900 hover:bg-gray-100 font-mono text-xs">
                      ×
                    </button>
                  )}
                </div>
              ) : (
canEdit && (
                  <button onClick={() => setShowNote(true)}
                    className="self-start px-2 py-1 rounded-md text-gray-600 hover:text-gray-900 hover:bg-gray-100 font-mono text-xs">
                    + Add note
                  </button>
                )
              )}
            </div>

            {/* Right column — totals + payments */}
            <div className="flex flex-col gap-2 min-h-0 overflow-y-auto">
              <div className="bg-gray-100 rounded-xl p-3 flex flex-col gap-1.5">
                <Row label="Subtotal" value={formatMoneyCents(subtotalCents)} />
                <RowEdit label="Discount" value={ticketDiscountInput}
                  onChange={(v) => setTicketDiscountInput(v)}
                  onBlur={(v) => setTicketDiscountInput((parseDollarsToCents(v) / 100).toFixed(2))}
                  disabled={!canEdit || !note.trim()}
                  title={!canEdit ? undefined : (!note.trim() ? 'Add a note before applying a discount.' : undefined)} />
                <RowEdit label="Tax" value={taxInput}
                  onChange={(v) => setTaxInput(v)}
                  onBlur={(v) => setTaxInput((parseDollarsToCents(v) / 100).toFixed(2))}
                  disabled={!canEdit} />
                <RowEdit label="Tip" value={tipInput}
                  onChange={(v) => setTipInput(v)}
                  onBlur={(v) => setTipInput((parseDollarsToCents(v) / 100).toFixed(2))}
                  disabled={!canEdit} />
                <div className="border-t border-gray-300 my-0.5" />
                <Row label="Total" value={formatMoneyCents(totalCents)} bold />
              </div>

              {/* Payment method buttons — pulled up so the cashier can pick a
                  tender immediately after seeing Total. Each click adds a
                  pending row below, defaulting to the remaining due. */}
              {canEdit ? (
                <>
                  <div className="grid grid-cols-3 gap-1.5">
                    <PayBtn label="Cash" tone="cash" onClick={() => addPending('cash')} />
                    <PayBtn label="Card" tone="card" onClick={() => addPending('visa_mc')} />
                    <PayBtn label="Gift" tone="gift" onClick={() => setShowGiftRedeem(true)} />
                  </div>
                  {pending.length > 0 && (
                    <div className="border border-gray-200 rounded-xl divide-y divide-gray-100">
                      {pending.map((p, idx) => (
                        <div key={idx} className="px-2.5 py-2 flex items-center gap-1.5">
                          <span className="font-mono text-sm font-bold text-gray-700 w-16">
                            {p.method === 'visa_mc' ? 'CARD' : p.method.toUpperCase()}
                          </span>
                          <span className="font-mono text-sm text-gray-600">$</span>
                          <input
                            type="text" inputMode="decimal" value={p.amountInput}
                            onChange={(e) => {
                              // Hard cap gift redemptions at the looked-up
                              // balance. Other methods accept any amount.
                              const next = p.method === 'gift'
                                ? capGiftAmountToBalance(p.giftCardCode ?? '', e.target.value)
                                : e.target.value;
                              patchPending(idx, { amountInput: next });
                            }}
                            onBlur={(e) => {
                              const formatted = (parseDollarsToCents(e.target.value) / 100).toFixed(2);
                              const capped = p.method === 'gift'
                                ? capGiftAmountToBalance(p.giftCardCode ?? '', formatted)
                                : formatted;
                              patchPending(idx, { amountInput: capped });
                            }}
                            className="flex-1 px-2 py-1 rounded-md border border-gray-300 font-mono text-base text-right text-gray-900 focus:outline-none focus:border-gray-500"
                          />
                          <button onClick={() => removePending(idx)}
                            className="p-1 rounded-md text-gray-500 hover:text-red-600 hover:bg-red-50">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                      {pending.some((p) => p.method === 'gift') && (
                        <div className="px-2.5 py-2">
                          {pending.map((p, idx) => {
                            if (p.method !== 'gift') return null;
                            const norm = normalizeSerial(p.giftCardCode ?? '');
                            const lookup = norm ? giftBalances[norm] : undefined;
                            // Pink balance label: shows "Balance $X.XX" once we
                            // know the card exists, "Not found" if not, "..."
                            // while loading. Cashier sees it inline next to the
                            // GIFT CARD CODE header so they don't need to leave
                            // the field to check balance.
                            let pinkLabel = '';
                            if (lookup === 'loading') pinkLabel = '…';
                            else if (lookup === 'unknown') pinkLabel = '';
                            else if (lookup && !lookup.found) pinkLabel = 'Not found';
                            else if (lookup && lookup.found) pinkLabel = `Balance ${formatMoneyCents(lookup.balanceCents)}`;
                            return (
                              <div key={idx} className="mb-1 last:mb-0">
                                <div className="flex items-baseline gap-2">
                                  <label className="font-mono text-xs tracking-wider text-gray-700 uppercase font-semibold">Gift card code</label>
                                  {pinkLabel && (
                                    <span className="font-mono text-lg font-bold text-pink-600">{pinkLabel}</span>
                                  )}
                                </div>
                                <input
                                  type="text"
                                  value={p.giftCardCode ?? ''}
                                  onChange={(e) => patchPending(idx, { giftCardCode: e.target.value })}
                                  onBlur={(e) => { void refreshGiftBalance(e.target.value); }}
                                  className="mt-1 w-full px-2 py-1 rounded-md border border-gray-300 font-mono text-base text-gray-900 focus:outline-none focus:border-gray-500"
                                  placeholder="GC-####"
                                />
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="bg-gray-100 rounded-xl p-3 flex flex-col gap-1.5">
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
                  <div className="border border-gray-200 rounded-xl divide-y divide-gray-100">
                    {ticket.payments.length === 0 ? (
                      <div className="px-3 py-2.5 font-mono text-sm text-gray-600 text-center">No payments captured.</div>
                    ) : (
                      ticket.payments.map((p) => (
                        <div key={p.id} className="px-2.5 py-2 flex items-center justify-between">
                          <span className="font-mono text-sm font-bold text-gray-700 flex items-center gap-2">
                            {p.method === 'visa_mc' ? 'CARD' : p.method.toUpperCase()}
                            {p.method === 'gift' && (p.giftCardCode ?? '').trim() && (
                              <span className="font-mono text-[11px] font-semibold text-gray-500">#{(p.giftCardCode ?? '').trim()}</span>
                            )}
                          </span>
                          <span className="font-mono text-base text-gray-900">{formatMoneyCents(p.amountCents)}</span>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="bg-gray-100 rounded-xl p-3 flex flex-col gap-1.5">
                    <Row label="Amount Paid" value={formatMoneyCents(ticket.paidCents)} bold />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Footer — simplified action row. */}
        <div className="px-5 py-2.5 border-t border-gray-200 flex items-center justify-between gap-3 flex-wrap">
          {error && <p className="font-mono text-xs text-red-600 w-full sm:w-auto">{error}</p>}
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
                <span className="w-px h-8 bg-gray-200 mx-1" />
                <button onClick={async () => {
                  // SAVE on an OPEN ticket: persist line items/header AND any
                  // entered payment (even a partial one), then leave the ticket
                  // OPEN. PROCESS is still what closes it. The close-shift drawer
                  // already counts payment rows on open (non-voided) tickets, so a
                  // saved payment shows as collected right away, and RegisterScreen's
                  // payments-table subscription refetches so the captured-payments
                  // panel updates. (Per Tony 2026-06-06.)
                  // Block an over-balance gift redemption before saving it.
                  const giftErr = await giftOverdraftError();
                  if (giftErr) { setError(giftErr); return; }
                  const s = await doSave();
                  if (!s) return;
                  const payRes = await replaceTicketPayments(ticket.id, pending.map((p) => ({
                    method: p.method,
                    amountCents: parseDollarsToCents(p.amountInput),
                    giftCardCode: p.giftCardCode,
                  })));
                  if (!payRes) { setError('Saved items but could not save the payment.'); return; }
                }} disabled={busy !== 'idle'}
                  className="px-5 py-2.5 rounded-lg border border-gray-400 text-gray-800 hover:bg-gray-100 font-mono text-sm font-bold disabled:opacity-50">
                  {busy === 'saving' ? 'SAVING…' : 'SAVE'}
                </button>
                <button onClick={handleVoid} disabled={busy !== 'idle'}
                  className="px-5 py-2.5 rounded-lg border border-red-300 text-red-600 hover:bg-red-50 font-mono text-sm font-bold disabled:opacity-50">
                  {busy === 'voiding' ? 'VOIDING…' : 'VOID'}
                </button>
                <button
                  onClick={handleProcess}
                  disabled={busy !== 'idle' || !canProcess}
                  title={
                    !canProcess
                      ? lines.length === 0
                        ? 'Add at least one item before processing.'
                        : pending.length === 0
                        ? 'Add a payment first.'
                        : `Payments ${formatMoneyCents(pendingPaidCents)} ≠ total ${formatMoneyCents(totalCents)}.`
                      : undefined
                  }
                  className="px-6 py-2.5 rounded-lg bg-gray-900 text-white font-mono text-sm font-bold hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-gray-900"
                >
                  {busy === 'processing' ? 'PROCESSING…' : 'PROCESS'}
                </button>
              </>
            )}
            {!isOpen && !unlockedForEdit && (
              <>
                <button onClick={() => setShowEditGate(true)}
                  className="px-3 py-1.5 rounded-lg border border-gray-400 text-gray-800 hover:bg-gray-100 font-mono text-xs font-bold">
                  EDIT
                </button>
                <button onClick={onClose}
                  className="px-4 py-1.5 rounded-lg bg-gray-900 text-white font-mono text-xs font-bold hover:bg-gray-800">
                  CLOSE
                </button>
              </>
            )}
            {!isOpen && unlockedForEdit && (
              <>
                <span className="w-px h-6 bg-gray-200 mx-1" />
                <button onClick={async () => {
                  // Persist items/header via doSave, then for closed tickets
                  // also replace the payments table so method/amount edits
                  // (e.g. gift → card) actually stick.
                  const s = await doSave();
                  if (!s) return;
                  const payRes = await replaceTicketPayments(ticket.id, pending.map((p) => ({
                    method: p.method,
                    amountCents: parseDollarsToCents(p.amountInput),
                    giftCardCode: p.giftCardCode,
                  })));
                  if (!payRes) { setError('Saved items but could not update payments.'); return; }
                  onClose();
                }} disabled={busy !== 'idle'}
                  className="px-4 py-1.5 rounded-lg bg-gray-900 text-white font-mono text-xs font-bold hover:bg-gray-800 disabled:opacity-50">
                  {busy === 'saving' ? 'SAVING…' : 'SAVE'}
                </button>
                {/* VOID on a closed ticket — same PIN-gated flow as VOID on an
                    open ticket. voidTicket() now accepts a 'closed' source
                    state so the status flip + completed_services rollback both
                    run. Per user request 2026-05-22. */}
                <button onClick={handleVoid} disabled={busy !== 'idle'}
                  className="px-3 py-1.5 rounded-lg border border-red-300 text-red-600 hover:bg-red-50 font-mono text-xs font-bold disabled:opacity-50">
                  {busy === 'voiding' ? 'VOIDING…' : 'VOID'}
                </button>
                <button onClick={onClose}
                  className="px-3 py-1.5 rounded-lg border border-gray-400 text-gray-800 hover:bg-gray-100 font-mono text-xs font-bold">
                  CANCEL
                </button>
              </>
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
      {giftModalSerial !== null && (
        <GiftCardSaleModal
          serial={giftModalSerial}
          onClose={() => setGiftModalSerial(null)}
          onAdd={(serial, valueCents, staff) => addGiftLine(serial, valueCents, staff)}
        />
      )}
      {showGiftRedeem && (
        <GiftRedeemModal
          ticketId={ticket.id}
          dueCents={dueCents}
          onClose={() => setShowGiftRedeem(false)}
          onApply={(code, amountCents) => {
            setPending((prev) => [...prev, { method: 'gift', giftCardCode: code, amountInput: (amountCents / 100).toFixed(2) }]);
            void refreshGiftBalance(code);
            setShowGiftRedeem(false);
          }}
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
      <ReceptionistPinGate
        open={showEditGate}
        title="EDIT CLOSED TICKET"
        subtitle={`Editing Ticket #${ticket.ticketNumber} after checkout. Receptionist PIN required.`}
        confirmLabel="UNLOCK"
        tone="primary"
        receptionists={state.manicurists.filter((m) => m.isReceptionist)}
        onCancel={() => setShowEditGate(false)}
        onConfirm={() => { setShowEditGate(false); setUnlockedForEdit(true); }}
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
      <label className="font-mono text-[10px] tracking-wider font-semibold text-gray-600 uppercase">{label}</label>
      {children}
    </div>
  );
}

function Row({ label, value, bold, highlight }: { label: string; value: string; bold?: boolean; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={`font-mono text-base ${bold ? 'font-bold text-gray-900' : 'text-gray-700'}`}>{label}</span>
      <span className={`font-mono text-base ${bold ? 'font-bold' : ''} ${highlight ? 'text-pink-600' : 'text-gray-900'}`}>{value}</span>
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
      <span className="font-mono text-base text-gray-700">{label}</span>
      <div className="flex items-center gap-1">
        <span className="font-mono text-sm text-gray-600">$</span>
        <input
          type="text" inputMode="decimal" value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => onBlur(e.target.value)}
          disabled={disabled}
          title={title}
          className="w-24 px-2 py-0.5 rounded-md border border-transparent hover:border-gray-300 focus:border-gray-500 font-mono text-base text-right text-gray-900 focus:outline-none disabled:bg-transparent bg-white disabled:text-gray-500 disabled:cursor-not-allowed"
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
      ? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 hover:border-emerald-400'
      : tone === 'card'
      ? 'border-sky-300 bg-sky-50 text-sky-800 hover:bg-sky-100 hover:border-sky-400'
      : tone === 'gift'
      ? 'border-pink-300 bg-pink-50 text-pink-800 hover:bg-pink-100 hover:border-pink-400'
      : 'border-gray-300 text-gray-800 hover:bg-gray-50 hover:border-gray-400';
  return (
    <button
      onClick={onClick}
      className={`px-2 py-2.5 rounded-lg border-2 ${toneClasses} font-bebas text-lg tracking-widest transition-colors`}
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
      ? 'border-red-300 text-red-600 hover:bg-red-50'
      : 'border-gray-300 text-gray-800 hover:bg-gray-100';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-5 py-2.5 rounded-lg border ${toneClasses} font-mono text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed transition-colors`}
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
