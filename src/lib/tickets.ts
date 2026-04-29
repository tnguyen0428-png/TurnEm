// Tickets data layer. Self-contained — not threaded through AppContext for now,
// since tickets are read on-demand by the Register screen and the ticket modal.
// Money is integer cents end-to-end.

import { supabase } from './supabase';
import { getTodayLA } from '../utils/time';
import type { Payment, Ticket, TicketItem } from '../types';

// ── DB ↔ TS mappers ──────────────────────────────────────────────────────────

interface DbTicket {
  id: string;
  ticket_number: number;
  business_date: string;
  queue_entry_id: string | null;
  appointment_id: string | null;
  completed_service_id: string | null;
  shift_id: string | null;
  client_name: string;
  client_phone: string;
  client_email: string;
  primary_manicurist_id: string | null;
  primary_manicurist_name: string;
  primary_manicurist_color: string;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  tip_cents: number;
  total_cents: number;
  paid_cents: number;
  status: Ticket['status'];
  note: string;
  void_reason: string;
  opened_at: string;
  closed_at: string | null;
  updated_at: string;
}

interface DbTicketItem {
  id: string;
  ticket_id: string;
  kind: TicketItem['kind'];
  name: string;
  service_id: string | null;
  staff1_id: string | null;
  staff1_name: string;
  staff1_color: string;
  staff2_id: string | null;
  staff2_name: string;
  staff2_color: string;
  unit_price_cents: number;
  quantity: number;
  discount_cents: number;
  ext_price_cents: number;
  sort_order: number;
}

interface DbPayment {
  id: string;
  ticket_id: string;
  shift_id: string | null;
  method: Payment['method'];
  amount_cents: number;
  tendered_cents: number | null;
  change_cents: number | null;
  gift_card_code: string;
  processor: Payment['processor'];
  processor_payment_id: string;
  card_brand: string;
  card_last4: string;
  refund_of: string | null;
  captured_at: string;
}

function fromDbItem(row: DbTicketItem): TicketItem {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    kind: row.kind,
    name: row.name,
    serviceId: row.service_id,
    staff1Id: row.staff1_id,
    staff1Name: row.staff1_name,
    staff1Color: row.staff1_color,
    staff2Id: row.staff2_id,
    staff2Name: row.staff2_name,
    staff2Color: row.staff2_color,
    unitPriceCents: row.unit_price_cents,
    quantity: row.quantity,
    discountCents: row.discount_cents,
    extPriceCents: row.ext_price_cents,
    sortOrder: row.sort_order,
  };
}

function fromDbPayment(row: DbPayment): Payment {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    shiftId: row.shift_id,
    method: row.method,
    amountCents: row.amount_cents,
    tenderedCents: row.tendered_cents,
    changeCents: row.change_cents,
    giftCardCode: row.gift_card_code,
    processor: row.processor,
    processorPaymentId: row.processor_payment_id,
    cardBrand: row.card_brand,
    cardLast4: row.card_last4,
    refundOf: row.refund_of,
    capturedAt: new Date(row.captured_at).getTime(),
  };
}

function fromDbTicket(row: DbTicket, items: DbTicketItem[], payments: DbPayment[]): Ticket {
  return {
    id: row.id,
    ticketNumber: row.ticket_number,
    businessDate: row.business_date,
    queueEntryId: row.queue_entry_id,
    appointmentId: row.appointment_id,
    completedServiceId: row.completed_service_id,
    shiftId: row.shift_id,
    clientName: row.client_name,
    clientPhone: row.client_phone,
    clientEmail: row.client_email,
    primaryManicuristId: row.primary_manicurist_id,
    primaryManicuristName: row.primary_manicurist_name,
    primaryManicuristColor: row.primary_manicurist_color,
    subtotalCents: row.subtotal_cents,
    discountCents: row.discount_cents,
    taxCents: row.tax_cents,
    tipCents: row.tip_cents,
    totalCents: row.total_cents,
    paidCents: row.paid_cents,
    status: row.status,
    note: row.note,
    voidReason: row.void_reason,
    openedAt: new Date(row.opened_at).getTime(),
    closedAt: row.closed_at ? new Date(row.closed_at).getTime() : null,
    updatedAt: new Date(row.updated_at).getTime(),
    items: items
      .filter((i) => i.ticket_id === row.id)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(fromDbItem),
    payments: payments
      .filter((p) => p.ticket_id === row.id)
      .sort((a, b) => new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime())
      .map(fromDbPayment),
  };
}

// ── money formatting ─────────────────────────────────────────────────────────

/**
 * Format integer cents as a dollar string. Negative values get a leading
 * minus, never parens. Always shows two decimals.
 */
export function formatMoneyCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}$${dollars.toLocaleString('en-US')}.${remainder.toString().padStart(2, '0')}`;
}

/**
 * Coerce a free-text dollar input into integer cents. Strips $, commas, and
 * whitespace. Negative numbers and decimals supported. Empty/garbage → 0.
 * Rounds to the nearest cent (avoids 5.005 → 500 floor truncation).
 */
export function parseDollarsToCents(input: string | number | null | undefined): number {
  if (input == null) return 0;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return 0;
    return Math.round(input * 100);
  }
  const cleaned = input.replace(/[$,\s]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return 0;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/**
 * Allocate the next gift-card serial number. Sequential, salon-wide. Reads
 * the current max serial off existing gift_card_sale ticket_items by name
 * pattern ("Gift Certificate #00042") and returns the next one as a
 * 5-digit padded string. Race-prone at huge scale but salon volume is far
 * below where that matters; if a collision ever happens the cashier just
 * picks a new number manually.
 */
export async function nextGiftCardSerial(): Promise<string> {
  const { data, error } = await supabase
    .from('ticket_items')
    .select('name')
    .eq('kind', 'gift_card_sale');
  if (error) {
    console.warn('[tickets] nextGiftCardSerial:', error.message);
    return '00001';
  }
  let max = 0;
  for (const row of (data ?? []) as Array<{ name: string }>) {
    const m = (row.name ?? '').match(/#(\d+)/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return String(max + 1).padStart(5, '0');
}

// ── pricing math ─────────────────────────────────────────────────────────────

export function computeLineExt(line: { unitPriceCents: number; quantity: number; discountCents: number }): number {
  return Math.max(0, line.unitPriceCents * line.quantity - line.discountCents);
}

export function computeTicketTotals(input: {
  items: Array<{ unitPriceCents: number; quantity: number; discountCents: number }>;
  ticketDiscountCents?: number;
  taxCents?: number;
  tipCents?: number;
}): { subtotalCents: number; totalCents: number } {
  const subtotalCents = input.items.reduce((s, it) => s + computeLineExt(it), 0);
  const totalCents = Math.max(
    0,
    subtotalCents - (input.ticketDiscountCents ?? 0) + (input.taxCents ?? 0) + (input.tipCents ?? 0),
  );
  return { subtotalCents, totalCents };
}

// ── reads ────────────────────────────────────────────────────────────────────

/** Fetch a single ticket with its items and payments. */
export async function fetchTicket(ticketId: string): Promise<Ticket | null> {
  const [tRes, iRes, pRes] = await Promise.all([
    supabase.from('tickets').select('*').eq('id', ticketId).maybeSingle(),
    supabase.from('ticket_items').select('*').eq('ticket_id', ticketId),
    supabase.from('payments').select('*').eq('ticket_id', ticketId),
  ]);
  if (tRes.error) { console.error('[tickets] fetchTicket:', tRes.error.message); return null; }
  if (!tRes.data) return null;
  return fromDbTicket(
    tRes.data as DbTicket,
    (iRes.data ?? []) as DbTicketItem[],
    (pRes.data ?? []) as DbPayment[],
  );
}

/**
 * List tickets for an LA-local business date. Use status filter to get just
 * Open or just Closed for the Register tab.
 */
export async function fetchTicketsForDate(
  dateLA: string,
  status?: Ticket['status'] | 'all',
): Promise<Ticket[]> {
  let query = supabase.from('tickets').select('*').eq('business_date', dateLA);
  if (status && status !== 'all') query = query.eq('status', status);
  query = query.order('opened_at', { ascending: false });
  const { data: tRows, error } = await query;
  if (error) { console.error('[tickets] fetchTicketsForDate:', error.message); return []; }
  if (!tRows || tRows.length === 0) return [];

  const ids = tRows.map((r) => (r as DbTicket).id);
  const [iRes, pRes] = await Promise.all([
    supabase.from('ticket_items').select('*').in('ticket_id', ids),
    supabase.from('payments').select('*').in('ticket_id', ids),
  ]);
  const items = (iRes.data ?? []) as DbTicketItem[];
  const payments = (pRes.data ?? []) as DbPayment[];
  return tRows.map((r) => fromDbTicket(r as DbTicket, items, payments));
}

/**
 * Find an existing OPEN ticket for the given client on a business date.
 * Matches in priority order:
 *   1. clientPhone (when both sides have one) — strict equality.
 *   2. clientName (case-insensitive trim) — fallback for walk-ins without
 *      a phone, or when one of them is missing the phone.
 *
 * Returns the most recently opened matching ticket, or null. Used to
 * consolidate multiple queue entries for the same visit onto one ticket.
 */
export async function findOpenTicketForClient(
  clientName: string,
  clientPhone: string,
  businessDate: string,
): Promise<Ticket | null> {
  const phone = (clientPhone ?? '').trim();
  const name = (clientName ?? '').trim();
  if (!name && !phone) return null;

  // Pull all open tickets for the date, then match in JS so we can do
  // case-insensitive name comparison without a Postgres ilike chain.
  const { data, error } = await supabase
    .from('tickets')
    .select('id, client_name, client_phone, opened_at')
    .eq('business_date', businessDate)
    .eq('status', 'open')
    .order('opened_at', { ascending: false });
  if (error) {
    console.warn('[tickets] findOpenTicketForClient:', error.message);
    return null;
  }
  if (!data || data.length === 0) return null;

  type Row = { id: string; client_name: string; client_phone: string; opened_at: string };
  const rows = data as Row[];

  // Phone match wins when both sides have a phone.
  if (phone) {
    const byPhone = rows.find((r) => (r.client_phone ?? '').trim() === phone);
    if (byPhone) return fetchTicket(byPhone.id);
  }
  // Otherwise fall back to case-insensitive name match.
  const lowerName = name.toLowerCase();
  const byName = rows.find((r) => (r.client_name ?? '').trim().toLowerCase() === lowerName);
  if (byName) return fetchTicket(byName.id);
  return null;
}

/** Find an existing ticket attached to a queue entry. */
export async function fetchTicketByQueueEntry(queueEntryId: string): Promise<Ticket | null> {
  const { data, error } = await supabase
    .from('tickets')
    .select('id')
    .eq('queue_entry_id', queueEntryId)
    .order('opened_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) { console.error('[tickets] fetchTicketByQueueEntry:', error.message); return null; }
  if (!data) return null;
  return fetchTicket((data as { id: string }).id);
}

/** Find an existing ticket attached to an appointment. */
export async function fetchTicketByAppointment(appointmentId: string): Promise<Ticket | null> {
  const { data, error } = await supabase
    .from('tickets')
    .select('id')
    .eq('appointment_id', appointmentId)
    .order('opened_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) { console.error('[tickets] fetchTicketByAppointment:', error.message); return null; }
  if (!data) return null;
  return fetchTicket((data as { id: string }).id);
}

// ── ticket creation (check-in) ───────────────────────────────────────────────

export interface CreateTicketAtCheckinInput {
  queueEntryId: string | null;
  appointmentId: string | null;
  clientName: string;
  clientPhone?: string;
  clientEmail?: string;
  primaryManicuristId: string | null;
  primaryManicuristName: string;
  primaryManicuristColor: string;
  /** Pre-populated services from the queue entry. Prices come from salon_services. */
  items: Array<{
    name: string;
    serviceId: string | null;
    staff1Id: string | null;
    staff1Name: string;
    staff1Color: string;
    unitPriceCents: number;
    quantity: number;
  }>;
  businessDate?: string; // YYYY-MM-DD; defaults to today LA
}

/**
 * Patch an open ticket's staff fields from a queue entry id, when the
 * ticket was created at queue-add time before a manicurist was assigned.
 *
 * Conservative by design: only fills fields that are currently empty/null.
 * Will not overwrite a manicurist a user already picked manually in the
 * ticket modal.
 *
 * Returns true if anything was changed, false if the ticket wasn't found
 * or already had staff. Network errors are logged but swallowed — this is
 * a background backfill, not a user-blocking action.
 */
export async function backfillTicketStaff(
  queueEntryId: string,
  manicuristId: string,
  manicuristName: string,
  manicuristColor: string,
): Promise<boolean> {
  if (!queueEntryId || !manicuristId) return false;

  // 1. Find the OPEN ticket linked to this queue entry. If the ticket has
  //    been closed/voided we leave it alone — staff edits there require
  //    explicit manager action.
  const { data: tRow, error: tErr } = await supabase
    .from('tickets')
    .select('id, primary_manicurist_id, status')
    .eq('queue_entry_id', queueEntryId)
    .eq('status', 'open')
    .maybeSingle();
  if (tErr) {
    console.warn('[tickets] backfillTicketStaff fetch:', tErr.message);
    return false;
  }
  if (!tRow) return false;

  const ticketId = (tRow as { id: string; primary_manicurist_id: string | null }).id;
  const currentPrimary = (tRow as { primary_manicurist_id: string | null }).primary_manicurist_id;

  let changed = false;

  // 2. Patch primary manicurist if currently empty.
  if (!currentPrimary) {
    const { error } = await supabase
      .from('tickets')
      .update({
        primary_manicurist_id: manicuristId,
        primary_manicurist_name: manicuristName,
        primary_manicurist_color: manicuristColor,
      })
      .eq('id', ticketId)
      .eq('status', 'open');
    if (error) {
      console.warn('[tickets] backfillTicketStaff ticket update:', error.message);
    } else {
      changed = true;
    }
  }

  // 3. Patch each ticket_items row's staff1_* fields IF currently null.
  //    Postgres `is.null` filter means we only target untouched rows.
  const { data: itemRows, error: iErr } = await supabase
    .from('ticket_items')
    .update({
      staff1_id: manicuristId,
      staff1_name: manicuristName,
      staff1_color: manicuristColor,
    })
    .eq('ticket_id', ticketId)
    .is('staff1_id', null)
    .select('id');
  if (iErr) {
    console.warn('[tickets] backfillTicketStaff items update:', iErr.message);
  } else if (itemRows && itemRows.length > 0) {
    changed = true;
  }

  return changed;
}

/**
 * Append additional service line items to an existing OPEN ticket and
 * recompute its subtotal/total. Used when a SPLIT_AND_ASSIGN sibling gets
 * assigned to a manicurist after the parent's ticket already exists — the
 * sibling's services get added to the same ticket, with each new line
 * tagged with the sibling's manicurist on staff1.
 *
 * Conservative: only inserts services NOT already present on the ticket
 * (matched on serviceId when set, else on case-insensitive name). Avoids
 * creating duplicate lines if a sync runs twice.
 *
 * Returns the refreshed ticket on success, null on failure.
 */
export async function appendItemsToTicket(
  ticketId: string,
  items: Array<{
    name: string;
    serviceId: string | null;
    staff1Id: string | null;
    staff1Name: string;
    staff1Color: string;
    unitPriceCents: number;
    quantity: number;
  }>,
): Promise<Ticket | null> {
  if (items.length === 0) return fetchTicket(ticketId);

  // Pull the existing ticket + its current items so we can de-dupe and
  // know the next sort_order to assign.
  const { data: tRow, error: tErr } = await supabase
    .from('tickets')
    .select('id, status, subtotal_cents, discount_cents, tax_cents, tip_cents')
    .eq('id', ticketId)
    .eq('status', 'open')
    .maybeSingle();
  if (tErr) {
    console.warn('[tickets] appendItemsToTicket fetch ticket:', tErr.message);
    return null;
  }
  if (!tRow) return null;

  const { data: existingItemRows, error: iErr } = await supabase
    .from('ticket_items')
    .select('service_id, name, sort_order')
    .eq('ticket_id', ticketId);
  if (iErr) {
    console.warn('[tickets] appendItemsToTicket fetch items:', iErr.message);
    return null;
  }
  const existing = (existingItemRows ?? []) as Array<{ service_id: string | null; name: string; sort_order: number }>;

  const seenServiceIds = new Set(existing.filter((e) => e.service_id).map((e) => e.service_id as string));
  const seenLowerNames = new Set(existing.filter((e) => !e.service_id).map((e) => (e.name ?? '').trim().toLowerCase()));
  const startSort = existing.reduce((m, r) => Math.max(m, r.sort_order ?? 0), 0) + 1;

  const toInsert = items.filter((it) => {
    if (it.serviceId) return !seenServiceIds.has(it.serviceId);
    return !seenLowerNames.has((it.name ?? '').trim().toLowerCase());
  });
  if (toInsert.length === 0) return fetchTicket(ticketId);

  const itemRows = toInsert.map((it, idx) => ({
    ticket_id: ticketId,
    kind: 'service' as const,
    name: it.name,
    service_id: it.serviceId,
    staff1_id: it.staff1Id,
    staff1_name: it.staff1Name,
    staff1_color: it.staff1Color,
    unit_price_cents: it.unitPriceCents,
    quantity: it.quantity,
    discount_cents: 0,
    ext_price_cents: Math.max(0, it.unitPriceCents * it.quantity),
    sort_order: startSort + idx,
  }));
  const { error: insErr } = await supabase.from('ticket_items').insert(itemRows);
  if (insErr) {
    console.warn('[tickets] appendItemsToTicket items insert:', insErr.message);
    return null;
  }

  // Recompute subtotal/total. Tip/tax/ticket-discount stay as-is — those
  // were entered manually by the cashier at checkout.
  const t = tRow as { subtotal_cents: number; discount_cents: number; tax_cents: number; tip_cents: number };
  const addedSubtotal = toInsert.reduce((s, it) => s + Math.max(0, it.unitPriceCents * it.quantity), 0);
  const newSubtotal = (t.subtotal_cents ?? 0) + addedSubtotal;
  const newTotal = Math.max(
    0,
    newSubtotal - (t.discount_cents ?? 0) + (t.tax_cents ?? 0) + (t.tip_cents ?? 0),
  );
  const { error: uErr } = await supabase
    .from('tickets')
    .update({ subtotal_cents: newSubtotal, total_cents: newTotal, updated_at: new Date().toISOString() })
    .eq('id', ticketId)
    .eq('status', 'open');
  if (uErr) {
    console.warn('[tickets] appendItemsToTicket totals update:', uErr.message);
  }

  return fetchTicket(ticketId);
}

/**
 * Allocate the next ticket number for the given business date. Race-prone at
 * scale, but the salon's daily volume is far below the threshold where that
 * matters. If a collision happens, the unique constraint will surface it and
 * the caller can retry with the next number.
 */
async function allocateNextTicketNumber(businessDate: string): Promise<number> {
  const { data, error } = await supabase
    .from('tickets')
    .select('ticket_number')
    .eq('business_date', businessDate)
    .order('ticket_number', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) { console.warn('[tickets] allocateNextTicketNumber:', error.message); }
  const max = data ? (data as { ticket_number: number }).ticket_number : 0;
  return max + 1;
}

/**
 * Create an Open ticket at check-in time. One row per visit. Items are
 * pre-populated from the queue entry's services with the catalog price.
 */
export async function createTicketAtCheckin(input: CreateTicketAtCheckinInput): Promise<Ticket | null> {
  const businessDate = input.businessDate ?? getTodayLA();
  const ticketNumber = await allocateNextTicketNumber(businessDate);

  const subtotalCents = input.items.reduce(
    (s, it) => s + Math.max(0, it.unitPriceCents * it.quantity),
    0,
  );

  const { data: tRow, error: tErr } = await supabase
    .from('tickets')
    .insert({
      ticket_number: ticketNumber,
      business_date: businessDate,
      queue_entry_id: input.queueEntryId,
      appointment_id: input.appointmentId,
      client_name: input.clientName || 'Walk-in',
      client_phone: input.clientPhone ?? '',
      client_email: input.clientEmail ?? '',
      primary_manicurist_id: input.primaryManicuristId,
      primary_manicurist_name: input.primaryManicuristName,
      primary_manicurist_color: input.primaryManicuristColor,
      subtotal_cents: subtotalCents,
      total_cents: subtotalCents, // no tax/tip/discount yet
      status: 'open',
    })
    .select('*')
    .single();
  if (tErr || !tRow) {
    console.error('[tickets] createTicketAtCheckin:', tErr?.message);
    return null;
  }

  const ticketId = (tRow as DbTicket).id;
  if (input.items.length > 0) {
    const itemRows = input.items.map((it, idx) => ({
      ticket_id: ticketId,
      kind: 'service' as const,
      name: it.name,
      service_id: it.serviceId,
      staff1_id: it.staff1Id,
      staff1_name: it.staff1Name,
      staff1_color: it.staff1Color,
      unit_price_cents: it.unitPriceCents,
      quantity: it.quantity,
      discount_cents: 0,
      ext_price_cents: Math.max(0, it.unitPriceCents * it.quantity),
      sort_order: idx,
    }));
    const { error: iErr } = await supabase.from('ticket_items').insert(itemRows);
    if (iErr) {
      console.error('[tickets] createTicketAtCheckin items, rolling back:', iErr.message);
      await supabase.from('tickets').delete().eq('id', ticketId);
      return null;
    }
  }

  return fetchTicket(ticketId);
}

// ── ticket edits (while open) ────────────────────────────────────────────────

export interface UpdateOpenTicketInput {
  ticketId: string;
  clientName?: string;
  clientPhone?: string;
  clientEmail?: string;
  primaryManicuristId?: string | null;
  primaryManicuristName?: string;
  primaryManicuristColor?: string;
  note?: string;
  ticketDiscountCents?: number;
  tipCents?: number;
  taxCents?: number;
  items?: Array<{
    id?: string;
    kind: TicketItem['kind'];
    name: string;
    serviceId: string | null;
    staff1Id: string | null;
    staff1Name: string;
    staff1Color: string;
    staff2Id: string | null;
    staff2Name: string;
    staff2Color: string;
    unitPriceCents: number;
    quantity: number;
    discountCents: number;
  }>;
}

/**
 * Update an open ticket. If `items` is passed we replace the items wholesale
 * (delete-and-reinsert) — simpler than diffing for this volume. Recomputes
 * subtotal and total from the items + ticket-level discount + tax + tip.
 */
export async function updateOpenTicket(input: UpdateOpenTicketInput): Promise<Ticket | null> {
  const headerPatch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.clientName !== undefined) headerPatch.client_name = input.clientName || 'Walk-in';
  if (input.clientPhone !== undefined) headerPatch.client_phone = input.clientPhone;
  if (input.clientEmail !== undefined) headerPatch.client_email = input.clientEmail;
  if (input.primaryManicuristId !== undefined) headerPatch.primary_manicurist_id = input.primaryManicuristId;
  if (input.primaryManicuristName !== undefined) headerPatch.primary_manicurist_name = input.primaryManicuristName;
  if (input.primaryManicuristColor !== undefined) headerPatch.primary_manicurist_color = input.primaryManicuristColor;
  if (input.note !== undefined) headerPatch.note = input.note;
  if (input.ticketDiscountCents !== undefined) headerPatch.discount_cents = input.ticketDiscountCents;
  if (input.tipCents !== undefined) headerPatch.tip_cents = input.tipCents;
  if (input.taxCents !== undefined) headerPatch.tax_cents = input.taxCents;

  // Replace items if provided.
  if (input.items) {
    const { error: dErr } = await supabase.from('ticket_items').delete().eq('ticket_id', input.ticketId);
    if (dErr) { console.error('[tickets] updateOpenTicket delete items:', dErr.message); return null; }
    if (input.items.length > 0) {
      const rows = input.items.map((it, idx) => ({
        ticket_id: input.ticketId,
        kind: it.kind,
        name: it.name,
        service_id: it.serviceId,
        staff1_id: it.staff1Id,
        staff1_name: it.staff1Name,
        staff1_color: it.staff1Color,
        staff2_id: it.staff2Id,
        staff2_name: it.staff2Name,
        staff2_color: it.staff2Color,
        unit_price_cents: it.unitPriceCents,
        quantity: it.quantity,
        discount_cents: it.discountCents,
        ext_price_cents: computeLineExt(it),
        sort_order: idx,
      }));
      const { error: iErr } = await supabase.from('ticket_items').insert(rows);
      if (iErr) { console.error('[tickets] updateOpenTicket insert items:', iErr.message); return null; }
    }
  }

  // Recompute totals from current items if items changed, otherwise read from DB.
  let subtotalCents = 0;
  if (input.items) {
    subtotalCents = input.items.reduce((s, it) => s + computeLineExt(it), 0);
  } else {
    const { data } = await supabase
      .from('ticket_items')
      .select('unit_price_cents, quantity, discount_cents')
      .eq('ticket_id', input.ticketId);
    subtotalCents = (data ?? []).reduce(
      (s, it) =>
        s +
        Math.max(
          0,
          (it as { unit_price_cents: number; quantity: number; discount_cents: number }).unit_price_cents *
            (it as { quantity: number }).quantity -
            (it as { discount_cents: number }).discount_cents,
        ),
      0,
    );
  }

  const ticketDiscount = input.ticketDiscountCents ?? null;
  const tax = input.taxCents ?? null;
  const tip = input.tipCents ?? null;

  // Read current values for any field not provided so total is consistent.
  if (ticketDiscount === null || tax === null || tip === null) {
    const { data: existing } = await supabase
      .from('tickets')
      .select('discount_cents, tax_cents, tip_cents')
      .eq('id', input.ticketId)
      .maybeSingle();
    const e = existing as { discount_cents: number; tax_cents: number; tip_cents: number } | null;
    headerPatch.subtotal_cents = subtotalCents;
    headerPatch.total_cents = Math.max(
      0,
      subtotalCents -
        (ticketDiscount ?? e?.discount_cents ?? 0) +
        (tax ?? e?.tax_cents ?? 0) +
        (tip ?? e?.tip_cents ?? 0),
    );
  } else {
    headerPatch.subtotal_cents = subtotalCents;
    headerPatch.total_cents = Math.max(0, subtotalCents - ticketDiscount + tax + tip);
  }

  const { error: uErr } = await supabase.from('tickets').update(headerPatch).eq('id', input.ticketId);
  if (uErr) { console.error('[tickets] updateOpenTicket header:', uErr.message); return null; }

  return fetchTicket(input.ticketId);
}

// ── close ticket (process payment) ───────────────────────────────────────────

export interface ClosingPaymentInput {
  method: Payment['method'];
  amountCents: number;
  tenderedCents?: number;
  changeCents?: number;
  giftCardCode?: string;
}

export interface CloseTicketInput {
  ticketId: string;
  shiftId: string | null;
  payments: ClosingPaymentInput[];
}

/**
 * Mark an open ticket closed: insert payment rows, set status='closed',
 * record closed_at and shift_id, refresh paid_cents. The ticket is locked
 * for edits after this returns successfully.
 */
export async function closeTicket(input: CloseTicketInput): Promise<Ticket | null> {
  if (input.payments.length === 0) {
    console.error('[tickets] closeTicket: no payments provided');
    return null;
  }

  // 1. Insert payment rows.
  const paymentRows = input.payments.map((p) => ({
    ticket_id: input.ticketId,
    shift_id: input.shiftId,
    method: p.method,
    amount_cents: p.amountCents,
    tendered_cents: p.tenderedCents ?? null,
    change_cents: p.changeCents ?? null,
    gift_card_code: p.giftCardCode ?? '',
  }));
  const { error: pErr } = await supabase.from('payments').insert(paymentRows);
  if (pErr) {
    console.error('[tickets] closeTicket payments insert:', pErr.message);
    return null;
  }

  // 2. Compute paid_cents and flip status to closed.
  const paidCents = input.payments.reduce((s, p) => s + p.amountCents, 0);
  const { error: tErr } = await supabase
    .from('tickets')
    .update({
      status: 'closed',
      closed_at: new Date().toISOString(),
      shift_id: input.shiftId,
      paid_cents: paidCents,
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.ticketId)
    .eq('status', 'open');
  if (tErr) {
    console.error('[tickets] closeTicket ticket update:', tErr.message);
    return null;
  }

  return fetchTicket(input.ticketId);
}

// void ticket --------------------------------------------------------------

/**
 * Mark an open ticket as voided. Idempotent at the status layer: a second
 * call where status is already 'voided' is a no-op. Manager-gated in the UI;
 * no database role check here yet.
 */
export async function voidTicket(ticketId: string, reason: string): Promise<boolean> {
  const { error } = await supabase
    .from('tickets')
    .update({
      status: 'voided',
      void_reason: reason,
      closed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', ticketId)
    .eq('status', 'open');
  if (error) {
    console.error('[tickets] voidTicket:', error.message);
    return false;
  }
  return true;
}
