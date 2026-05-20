// Tickets data layer. Self-contained — not threaded through AppContext for now,
// since tickets are read on-demand by the Register screen and the ticket modal.
// Money is integer cents end-to-end.

import { supabase } from './supabase';
import { getTodayLA } from '../utils/time';
import type { Payment, Ticket, TicketItem } from '../types';

// ── visit id helper ─────────────────────────────────────────────────────────
//
// All queue entries derive from a "parent" UUID. SPLIT_AND_ASSIGN children
// have ids of the form `${parent}-${manicuristId}` or `${parent}-waiting`,
// where the parent is a standard 36-char v4 UUID. A non-split entry's id IS
// the parent. Tickets are keyed on the parent (the "visit id"), so when we
// need to ask "which ticket does this queue entry / completed services row
// belong to?" we must use the parent prefix, not the row's raw id.
//
// getVisitId pulls the leading UUID off an id. If the id is a plain UUID
// (non-split case) it returns the id unchanged. If the id has a suffix
// (split child) it returns the parent UUID alone.

const VISIT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function getVisitId(id: string): string {
  if (!id) return id;
  const m = id.match(VISIT_ID_RE);
  return m ? m[0] : id;
}

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
  voided_by_receptionist_id: string | null;
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
  /** Specific queue entry id that produced this line (child id for split
   *  visits, own id for non-split). Null for manually-added lines from the
   *  ticket modal. */
  queue_entry_id: string | null;
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
    queueEntryId: row.queue_entry_id ?? null,
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
    voidedByReceptionistId: row.voided_by_receptionist_id ?? null,
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
 * pattern ("Gift Certificate #1606834460") and returns the next one as a
 * 5-digit-min padded string. Race-prone at huge scale but salon volume is far
 * below where that matters; if a collision ever happens the cashier just
 * picks a new number manually.
 *
 * Paginated: Supabase caps a single .select() at 1000 rows by default and
 * we silently undercount the max once we cross that threshold (which we
 * did after the SalonBiz history import). We page through in chunks and
 * track the max as we go.
 */
export async function nextGiftCardSerial(): Promise<string> {
  const pageSize = 1000;
  let max = 0;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('ticket_items')
      .select('name')
      .eq('kind', 'gift_card_sale')
      .range(offset, offset + pageSize - 1);
    if (error) {
      console.warn('[tickets] nextGiftCardSerial:', error.message);
      return '00001';
    }
    const rows = (data ?? []) as Array<{ name: string }>;
    for (const row of rows) {
      const m = (row.name ?? '').match(/#(\d+)/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return String(max + 1).padStart(5, '0');
}

// ── pricing math ─────────────────────────────────────────────────────────────

export function computeLineExt(line: { unitPriceCents: number; quantity: number; discountCents: number }): number {
  return Math.max(0, line.unitPriceCents * line.quantity - line.discountCents);
}

// ── reads ────────────────────────────────────────────────────────────────────

/** Fetch a single ticket with its items and payments. Internal — used by
 * fetchTicketByQueueEntry and the reconcile helpers. Not exported because
 * no external caller needs to read a ticket by raw id today. */
async function fetchTicket(ticketId: string): Promise<Ticket | null> {
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
// Paginated reads of children scoped by ticket_id. Supabase caps a single
// .select() at 1000 rows by default. A single bootstrap ticket (the SalonBiz
// gift-cert migration) carries ~1900 line items and starved the page —
// fetchTicketsForDate's `.in('ticket_id', ids)` for items returned all 1000
// rows of the migration ticket and zero rows for every other open ticket on
// the same day, leaving the Register's SERVICES column blank.
const PAGE_SIZE = 1000;
async function fetchItemsForTicketIds(ids: string[]): Promise<DbTicketItem[]> {
  if (ids.length === 0) return [];
  const out: DbTicketItem[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('ticket_items')
      .select('*')
      .in('ticket_id', ids)
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) { console.error('[tickets] fetchItemsForTicketIds:', error.message); return out; }
    const rows = (data ?? []) as DbTicketItem[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}
async function fetchPaymentsForTicketIds(ids: string[]): Promise<DbPayment[]> {
  if (ids.length === 0) return [];
  const out: DbPayment[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('payments')
      .select('*')
      .in('ticket_id', ids)
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) { console.error('[tickets] fetchPaymentsForTicketIds:', error.message); return out; }
    const rows = (data ?? []) as DbPayment[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

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
  const [items, payments] = await Promise.all([
    fetchItemsForTicketIds(ids),
    fetchPaymentsForTicketIds(ids),
  ]);
  return tRows.map((r) => fromDbTicket(r as DbTicket, items, payments));
}

/**
 * List every ticket attached to a single shift (i.e. closed against it).
 * Used by the Close Shift screen to show itemized payment and ticket lists.
 */
export async function fetchTicketsForShift(shiftId: string): Promise<Ticket[]> {
  const { data: tRows, error } = await supabase
    .from('tickets')
    .select('*')
    .eq('shift_id', shiftId)
    .order('closed_at', { ascending: true });
  if (error) { console.error('[tickets] fetchTicketsForShift:', error.message); return []; }
  if (!tRows || tRows.length === 0) return [];

  const ids = tRows.map((r) => (r as DbTicket).id);
  const [items, payments] = await Promise.all([
    fetchItemsForTicketIds(ids),
    fetchPaymentsForTicketIds(ids),
  ]);
  return tRows.map((r) => fromDbTicket(r as DbTicket, items, payments));
}

/**
 * List tickets across an inclusive LA-local business-date range — used by the
 * Reports tabs. Returns every ticket whose `business_date` falls in
 * [fromDateLA, toDateLA], regardless of status. Caller can filter further.
 */
export async function fetchTicketsForRange(
  fromDateLA: string,
  toDateLA: string,
): Promise<Ticket[]> {
  const { data: tRows, error } = await supabase
    .from('tickets')
    .select('*')
    .gte('business_date', fromDateLA)
    .lte('business_date', toDateLA)
    .order('opened_at', { ascending: false });
  if (error) { console.error('[tickets] fetchTicketsForRange:', error.message); return []; }
  if (!tRows || tRows.length === 0) return [];

  const ids = tRows.map((r) => (r as DbTicket).id);
  const [items, payments] = await Promise.all([
    fetchItemsForTicketIds(ids),
    fetchPaymentsForTicketIds(ids),
  ]);
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

/**
 * Reconcile: for each completed entry on `dateLA` that has no matching
 * ticket, either:
 *   - append its services to an existing OPEN ticket for the same client
 *     (so a customer who got a manicure + pedicure ends up on one ticket
 *     for checkout), or
 *   - create a new ticket if no open ticket for that client exists.
 *
 * Returns { created, appendedTo } counts so callers can log.
 *
 * Matching priority for "same client":
 *   1. Phone match (when both sides have a phone)
 *   2. Case-insensitive trimmed name match
 * Same priority that `findOpenTicketForClient` uses elsewhere in the app.
 *
 * Idempotent — safe to run repeatedly. The first pass checks queue_entry_id
 * uniqueness; the consolidation pass keeps appending into the same open
 * ticket without ever duplicating service lines (appendItemsToTicket already
 * de-dupes by name + serviceId).
 */
export async function reconcileMissingTicketsForDate(
  dateLA: string,
  completedEntries: Array<{
    id: string;
    clientName: string;
    clientPhone?: string;
    services: string[];
    manicuristId: string;
    manicuristName: string;
    manicuristColor: string;
    completedAt: number;
  }>,
  salonServices: Array<{ id: string; name: string; price: number }>,
): Promise<{ created: number; appendedTo: number }> {
  if (completedEntries.length === 0) return { created: 0, appendedTo: 0 };

  // Bulk-fetch in one round trip: every ticket for the date plus its lookup
  // keys (queue_entry_id, client_name/phone, primary_manicurist_id). The
  // previous implementation re-queried for every completed entry via
  // findOpenTicketForClient — O(N) round trips for N candidates. This is
  // O(1) plus pure-JS lookups inside the loop.
  const { data: existing, error } = await supabase
    .from('tickets')
    .select('id, queue_entry_id, client_name, client_phone, primary_manicurist_id, status')
    .eq('business_date', dateLA);
  if (error) {
    console.warn('[tickets] reconcileMissingTicketsForDate fetch failed:', error.message);
    return { created: 0, appendedTo: 0 };
  }
  type ExistingRow = {
    id: string;
    queue_entry_id: string | null;
    client_name: string | null;
    client_phone: string | null;
    primary_manicurist_id: string | null;
    status: string;
  };
  const existingRows = (existing ?? []) as ExistingRow[];
  // Set of "visit ids" already on a ticket. We NORMALIZE through getVisitId
  // here so the set always contains the bare visit UUID, even if a given
  // ticket happens to store a non-canonical suffixed form like
  // `${parent}-waiting` in its queue_entry_id (older code paths and the DB
  // trigger using parent_queue_id directly can both produce that).
  // Without this normalization, an existing ticket with a suffixed
  // queue_entry_id would be invisible to `existingByVisitId.has(visitId)`
  // on the lookup side (which IS normalized via getVisitId), and we'd
  // create a phantom duplicate ticket. Seen in ticket #66 (2026-05-17).
  const existingByVisitId = new Set(
    existingRows
      .map((r) => (r.queue_entry_id ? getVisitId(r.queue_entry_id) : null))
      .filter((v): v is string => !!v),
  );

  // Lookup maps for the "is there already an open ticket for this client?"
  // check. Phone wins when both sides have one, then case-insensitive name.
  // We only consider OPEN tickets — closed/voided tickets shouldn't absorb
  // newly completed services.
  type OpenLookup = { id: string; primaryManicuristId: string | null };
  const openByPhone = new Map<string, OpenLookup>();
  const openByName = new Map<string, OpenLookup>();
  for (const r of existingRows) {
    if (r.status !== 'open') continue;
    const lookup: OpenLookup = { id: r.id, primaryManicuristId: r.primary_manicurist_id };
    const phone = (r.client_phone ?? '').trim();
    if (phone) openByPhone.set(phone, lookup);
    const lname = (r.client_name ?? '').trim().toLowerCase();
    // 'walk-in' is the generic name — never merge two anonymous walk-ins.
    if (lname && lname !== 'walk-in') openByName.set(lname, lookup);
  }

  // Sort by completion time so the first service for a given client wins
  // the "create" path, and subsequent ones append.
  const ordered = [...completedEntries].sort((a, b) => a.completedAt - b.completedAt);

  let created = 0;
  let appendedTo = 0;

  for (const c of ordered) {
    if (!c.manicuristId) continue;          // can't credit a ticket without staff
    const visitId = getVisitId(c.id);
    if (existingByVisitId.has(visitId)) continue; // already linked to a ticket via the visit

    const items = (c.services ?? [])
      .filter((name) => typeof name === 'string' && name.trim().length > 0)
      .map((svcName) => {
        const svc = salonServices.find((s) => s.name === svcName);
        return {
          name: svcName,
          serviceId: svc?.id ?? null,
          staff1Id: c.manicuristId,
          staff1Name: c.manicuristName,
          staff1Color: c.manicuristColor,
          unitPriceCents: Math.round((svc?.price ?? 0) * 100),
          quantity: 1,
        };
      });
    if (items.length === 0) continue;

    // Look for an existing OPEN ticket for the same client on this date in
    // the in-memory map. No round trip.
    const phone = (c.clientPhone ?? '').trim();
    const lname = (c.clientName ?? '').trim().toLowerCase();
    const match =
      (phone && openByPhone.get(phone)) ||
      (lname && lname !== 'walk-in' ? openByName.get(lname) : undefined);

    if (match) {
      await appendItemsToTicket(match.id, items, { allowDuplicates: true });
      // Backfill staff on the existing ticket if it's missing one.
      if (!match.primaryManicuristId && c.manicuristId) {
        await backfillTicketStaff(
          // No queue_entry_id captured in the lookup; fall back to the
          // visit id which matches what backfillTicketStaff expects for
          // ticket-creation cases (it looks up tickets by queue_entry_id).
          visitId,
          c.manicuristId,
          c.manicuristName,
          c.manicuristColor,
        );
        match.primaryManicuristId = c.manicuristId;
      }
      // Record the visit id so subsequent split-sibling iterations don't
      // re-append the same lines on this run.
      existingByVisitId.add(visitId);
      appendedTo += 1;
      continue;
    }

    const ticket = await createTicketAtCheckin({
      // Always store the visit id on the ticket. For non-split entries this
      // equals c.id; for SPLIT_AND_ASSIGN children it points at the parent
      // so subsequent siblings find this same ticket on lookup.
      queueEntryId: visitId,
      appointmentId: null,
      clientName: c.clientName,
      primaryManicuristId: c.manicuristId,
      primaryManicuristName: c.manicuristName,
      primaryManicuristColor: c.manicuristColor,
      items,
      businessDate: dateLA,
    });
    if (ticket) {
      created += 1;
      existingByVisitId.add(visitId);
      // Register the newly-created ticket in the lookups so the next
      // iteration for the same client appends to it instead of creating a
      // second ticket.
      const lookup: OpenLookup = { id: ticket.id, primaryManicuristId: c.manicuristId };
      if (phone) openByPhone.set(phone, lookup);
      if (lname && lname !== 'walk-in') openByName.set(lname, lookup);
    }
  }
  return { created, appendedTo };
}

/**
 * Find groups of OPEN tickets for the same client on a business date and
 * merge them into one. The oldest ticket wins ("primary"); each "secondary"
 * has its line items appended into the primary and is then deleted.
 *
 * Match priority for "same client":
 *   - phone equality if both sides have a phone, else
 *   - case-insensitive trimmed name equality
 *
 * Idempotent — once merged the next pass finds only single tickets per
 * client and does nothing.
 *
 * Returns the number of secondary tickets that were merged + deleted.
 */
export async function mergeOpenTicketsByClient(dateLA: string): Promise<number> {
  const { data: rows, error } = await supabase
    .from('tickets')
    .select('id, client_name, client_phone, opened_at')
    .eq('business_date', dateLA)
    .eq('status', 'open')
    .order('opened_at', { ascending: true });
  if (error) {
    console.warn('[tickets] mergeOpenTicketsByClient fetch failed:', error.message);
    return 0;
  }
  if (!rows || rows.length < 2) return 0;

  type Row = { id: string; client_name: string; client_phone: string; opened_at: string };
  const open = rows as Row[];

  // Group by phone first (when present), else by lowercased trimmed name.
  function keyOf(r: Row): string | null {
    const phone = (r.client_phone ?? '').trim();
    if (phone) return `p:${phone}`;
    const name = (r.client_name ?? '').trim().toLowerCase();
    if (!name) return null; // anonymous, never merge
    if (name === 'walk-in') return null; // multiple generic walk-ins should stay separate
    return `n:${name}`;
  }

  const groups = new Map<string, Row[]>();
  for (const r of open) {
    const k = keyOf(r);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }

  let merged = 0;
  for (const [, list] of groups) {
    if (list.length < 2) continue;
    // Oldest = primary (first by opened_at asc).
    const [primary, ...secondaries] = list;

    for (const sec of secondaries) {
      // Pull the secondary's items and dispatch them through
      // appendItemsToTicket — that path handles de-dupe + totals recompute.
      const { data: itemRows, error: iErr } = await supabase
        .from('ticket_items')
        .select('*')
        .eq('ticket_id', sec.id);
      if (iErr) {
        console.warn('[tickets] mergeOpenTicketsByClient items fetch:', iErr.message);
        continue;
      }
      const items = (itemRows ?? []) as DbTicketItem[];
      const toAppend = items.map((it) => ({
        name: it.name,
        serviceId: it.service_id,
        staff1Id: it.staff1_id,
        staff1Name: it.staff1_name,
        staff1Color: it.staff1_color,
        unitPriceCents: it.unit_price_cents,
        quantity: it.quantity,
      }));
      if (toAppend.length > 0) {
        const r = await appendItemsToTicket(primary.id, toAppend, { allowDuplicates: true });
        if (!r) {
          console.warn('[tickets] mergeOpenTicketsByClient append failed, skipping delete for', sec.id);
          continue;
        }
      }
      // Delete the now-redundant secondary. ticket_items + payments cascade
      // via the DB schema; if a payment somehow exists on an OPEN ticket
      // (shouldn't, but just in case) it'll go with it.
      const { error: dErr } = await supabase.from('tickets').delete().eq('id', sec.id);
      if (dErr) {
        console.warn('[tickets] mergeOpenTicketsByClient delete failed:', dErr.message);
        continue;
      }
      merged += 1;
    }
  }
  return merged;
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

// fetchTicketByAppointment removed — no callers. Look up by queue entry or
// re-add this helper if you wire appointments to the register screen.

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
    /** Source queue entry id (child id for split visits). */
    queueEntryId?: string | null;
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
 * Remove ticket lines that were auto-created at queue-assignment time for
 * a queue entry that has since disappeared from the queue WITHOUT being
 * completed. Without this cleanup the ticket keeps billing the client for
 * services the manicurist never performed — e.g. a cashier ran
 * MultiServiceAssign, changed their mind, and reassigned to different
 * staff before the work happened.
 *
 * Safety rails:
 *   - Only targets `kind = 'service'` rows with the specific staff1_id;
 *     never touches retail, discounts, or gift-card lines.
 *   - Cross-checks `completed_services` for the same visit + staff: if any
 *     candidate service has a matching completion record, we keep the
 *     ticket line. Real work always wins over the orphan heuristic.
 *   - Returns the count of rows actually removed; safe to call when the
 *     entry never had a ticket line.
 *
 * `visitId` is the visit id (parent UUID) the ticket is keyed on. `staffId`
 * is the manicurist the entry was assigned to (what landed on staff1_id at
 * append time). `services` is the entry's services array; each name is
 * matched case-insensitively against ticket_items.name.
 */
export async function removeOrphanTicketLines(
  visitId: string,
  staffId: string,
  services: string[],
): Promise<number> {
  if (!visitId || !staffId || !services || services.length === 0) return 0;

  // 1. Find the open ticket for this visit.
  const { data: tRow, error: tErr } = await supabase
    .from('tickets')
    .select('id, subtotal_cents, discount_cents, tax_cents, tip_cents')
    .eq('queue_entry_id', visitId)
    .eq('status', 'open')
    .maybeSingle();
  if (tErr) {
    console.warn('[tickets] removeOrphanTicketLines find ticket:', tErr.message);
    return 0;
  }
  if (!tRow) return 0;
  const ticket = tRow as {
    id: string;
    subtotal_cents: number;
    discount_cents: number;
    tax_cents: number;
    tip_cents: number;
  };

  // 2. Candidate services (lowercased) the entry claimed it would perform.
  const candidateLower = new Set(
    services
      .map((s) => (s ?? '').trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
  if (candidateLower.size === 0) return 0;

  // 3. Subtract anything that DID complete for this staff + visit. Match
  //    completed_services.id by prefix because SPLIT_AND_ASSIGN children
  //    have ids like `${visitId}-mani-N`, `${visitId}-waiting`, or even
  //    `${visitId}-waiting-mani-N` for nested splits.
  const { data: completedRows, error: cErr } = await supabase
    .from('completed_services')
    .select('services, manicurist_id')
    .eq('manicurist_id', staffId)
    .like('id', `${visitId}%`);
  if (cErr) {
    console.warn('[tickets] removeOrphanTicketLines completed lookup:', cErr.message);
  }
  const performed = new Set<string>();
  for (const r of (completedRows ?? []) as Array<{ services: string[] | null }>) {
    for (const svc of r.services ?? []) {
      performed.add((svc ?? '').trim().toLowerCase());
    }
  }
  const orphanLower = new Set<string>();
  for (const s of candidateLower) {
    if (!performed.has(s)) orphanLower.add(s);
  }
  if (orphanLower.size === 0) return 0;

  // 4. Find the matching ticket_items rows by ticket + kind + staff.
  const { data: candidateItems, error: iErr } = await supabase
    .from('ticket_items')
    .select('id, name, unit_price_cents, quantity, discount_cents')
    .eq('ticket_id', ticket.id)
    .eq('kind', 'service')
    .eq('staff1_id', staffId);
  if (iErr) {
    console.warn('[tickets] removeOrphanTicketLines items lookup:', iErr.message);
    return 0;
  }
  type ItemRow = {
    id: string;
    name: string;
    unit_price_cents: number;
    quantity: number;
    discount_cents: number;
  };
  const items = (candidateItems ?? []) as ItemRow[];
  const toDelete = items.filter((it) =>
    orphanLower.has((it.name ?? '').trim().toLowerCase()),
  );
  if (toDelete.length === 0) return 0;

  // 5. Delete and recompute totals.
  const { error: dErr } = await supabase
    .from('ticket_items')
    .delete()
    .in('id', toDelete.map((it) => it.id));
  if (dErr) {
    console.warn('[tickets] removeOrphanTicketLines delete:', dErr.message);
    return 0;
  }

  const removedSubtotal = toDelete.reduce(
    (s, it) => s + Math.max(0, it.unit_price_cents * it.quantity - it.discount_cents),
    0,
  );
  const newSubtotal = Math.max(0, (ticket.subtotal_cents ?? 0) - removedSubtotal);
  const newTotal = Math.max(
    0,
    newSubtotal -
      (ticket.discount_cents ?? 0) +
      (ticket.tax_cents ?? 0) +
      (ticket.tip_cents ?? 0),
  );
  const { error: uErr } = await supabase
    .from('tickets')
    .update({
      subtotal_cents: newSubtotal,
      total_cents: newTotal,
      updated_at: new Date().toISOString(),
    })
    .eq('id', ticket.id)
    .eq('status', 'open');
  if (uErr) {
    console.warn('[tickets] removeOrphanTicketLines totals update:', uErr.message);
  }

  return toDelete.length;
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
    /** Source queue entry. When present and already on the ticket, the
     *  line is skipped on dedupe — no matter what options.allowDuplicates
     *  says. Different siblings of a split visit pass different ids, so
     *  three manicures by the same staff land as three lines. */
    queueEntryId?: string | null;
  }>,
  options: { allowDuplicates?: boolean } = {},
): Promise<Ticket | null> {
  if (items.length === 0) return fetchTicket(ticketId);

  // Pull the existing ticket + its current items so we can de-dupe and
  // know the next sort_order to assign. auto_attributed_sources carries
  // the per-(source_row, service) tombstones the DB trigger writes —
  // see migration 20260520134828_ticket_trigger_per_service_tombstone
  // for the contract. We honor the same tombstones here so client-side
  // safety-net paths (AppContext syncCompleted, justAssigned, etc.)
  // can't resurrect a line the cashier just deleted via TicketModal.
  const { data: tRow, error: tErr } = await supabase
    .from('tickets')
    .select('id, status, subtotal_cents, discount_cents, tax_cents, tip_cents, auto_attributed_sources')
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
    .select('id, service_id, name, sort_order, queue_entry_id, staff1_id')
    .eq('ticket_id', ticketId);
  if (iErr) {
    console.warn('[tickets] appendItemsToTicket fetch items:', iErr.message);
    return null;
  }
  const existing = (existingItemRows ?? []) as Array<{
    id: string;
    service_id: string | null;
    name: string;
    sort_order: number;
    queue_entry_id: string | null;
    staff1_id: string | null;
  }>;
  const startSort = existing.reduce((m, r) => Math.max(m, r.sort_order ?? 0), 0) + 1;

  // Build a lookup so we can patch an existing line's staff in place when
  // an incoming item shares the same queue_entry_id but carries a different
  // manicurist. Without this, a cancel-then-reassign flow leaves the OLD
  // staff on the ticket: the dedupe below filters the incoming item out
  // because the qid already exists, and if the syncEntryToTicket reconcile
  // pass doesn't fire for that entry (e.g. a SPLIT_AND_ASSIGN re-fire whose
  // siblings are joined via the justAssigned path only), the stale staff
  // sticks on the line. Symptom: tickets that show BOTH the original and
  // the new manicurist instead of just the new one.
  const existingByQid = new Map<string, typeof existing[number]>();
  for (const e of existing) {
    if (e.queue_entry_id) existingByQid.set(e.queue_entry_id, e);
  }
  const staffPatchUpdates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  for (const it of items) {
    if (!it.queueEntryId) continue;
    const match = existingByQid.get(it.queueEntryId);
    if (!match) continue;
    if (it.staff1Id && match.staff1_id !== it.staff1Id) {
      staffPatchUpdates.push({
        id: match.id,
        patch: {
          staff1_id: it.staff1Id,
          staff1_name: it.staff1Name,
          staff1_color: it.staff1Color,
        },
      });
    }
  }

  // Entry-id first dedupe: any item whose queue_entry_id is already on the
  // ticket is a re-fire of a sync we already processed — skip the INSERT.
  // The staff-patch loop above handles the case where the re-fire wants to
  // change the staff. This rule applies regardless of options.allowDuplicates
  // because it's about NOT double-inserting the same source row.
  //
  // For items without a queue_entry_id (manual ticket-modal adds, legacy
  // backfilled flows), fall back to the older service-id / name dedupe so
  // we don't regress the existing behavior. allowDuplicates still bypasses
  // that fallback for callers that explicitly want every item to land.
  const seenEntryIds = new Set(
    existing.filter((e) => e.queue_entry_id).map((e) => e.queue_entry_id as string),
  );

  // Tombstone respect (mirrors the DB trigger fix in migration
  // 20260520134828): if `${source_row}::${service_name}` has already
  // been attributed once, never resurrect it. The trigger writes these
  // tuples on every fire whose service either landed on the ticket or
  // was guarded out. Without this client-side check, syncCompleted's
  // safety-net `appendItemsToTicket(..., { allowDuplicates: true })`
  // call ignores the tombstone and re-adds a line the cashier just
  // deleted via TicketModal.
  const attributed = ((tRow as { auto_attributed_sources?: string[] | null }).auto_attributed_sources ?? []) as string[];
  const tombstones = new Set(attributed.filter((a) => typeof a === 'string' && a.includes('::')));
  // For items WITHOUT a queueEntryId, also collapse by (sourceFromAnyExistingEntry::name)?
  // No — items without a queueEntryId are manual cashier adds; the cashier
  // is the source of truth there. Tombstone matching is qid-keyed.
  const tombstoneKey = (qid: string | null | undefined, name: string): string | null => {
    if (!qid) return null;
    const root = qid.includes('#') ? qid.split('#')[0] : qid;
    return `${root}::${name}`;
  };
  let toInsert = items.filter((it) => {
    if (it.queueEntryId && seenEntryIds.has(it.queueEntryId)) return false;
    const tk = tombstoneKey(it.queueEntryId, it.name);
    if (tk && tombstones.has(tk)) return false;
    return true;
  });
  if (!options.allowDuplicates) {
    const seenServiceIds = new Set(existing.filter((e) => e.service_id).map((e) => e.service_id as string));
    const seenLowerNames = new Set(existing.filter((e) => !e.service_id).map((e) => (e.name ?? '').trim().toLowerCase()));
    toInsert = toInsert.filter((it) => {
      // Items WITH a queue_entry_id that's NOT already on the ticket are
      // distinct work — never collapse them by service name.
      if (it.queueEntryId) return true;
      if (it.serviceId) return !seenServiceIds.has(it.serviceId);
      return !seenLowerNames.has((it.name ?? '').trim().toLowerCase());
    });
  }

  // Apply staff patches BEFORE the early-return on empty insert. The dedupe
  // filter above may leave nothing to insert (every incoming item already
  // has a line on the ticket by qid), but we still need to patch those
  // lines' staff when the queue side moved the work to a different
  // manicurist.
  if (staffPatchUpdates.length > 0) {
    for (const u of staffPatchUpdates) {
      const { error } = await supabase.from('ticket_items').update(u.patch).eq('id', u.id);
      if (error) {
        console.warn('[tickets] appendItemsToTicket staff patch:', error.message);
      }
    }
  }

  if (toInsert.length === 0) return fetchTicket(ticketId);

  // Suffix in-batch duplicate queue_entry_ids with `#N` so they don't
  // violate the partial unique index `uniq_ticket_items_per_entry`. NULL
  // qids are exempt because the index has WHERE queue_entry_id IS NOT NULL.
  const qeCount = new Map<string, number>();
  for (const it of toInsert) {
    if (it.queueEntryId != null) {
      qeCount.set(it.queueEntryId, (qeCount.get(it.queueEntryId) ?? 0) + 1);
    }
  }
  const qeUsed = new Map<string, number>();
  const itemRows = toInsert.map((it, idx) => {
    let qe: string | null = it.queueEntryId ?? null;
    if (qe != null && (qeCount.get(qe) ?? 0) > 1) {
      const used = (qeUsed.get(qe) ?? 0) + 1;
      qeUsed.set(qe, used);
      qe = `${qe}#${used}`;
    }
    return {
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
      queue_entry_id: qe,
    };
  });
  // Plain INSERT — the previous upsert used `onConflict:
  // 'ticket_id,queue_entry_id'`, but the underlying unique index is
  // PARTIAL (WHERE queue_entry_id IS NOT NULL). Supabase JS doesn't pass
  // the WHERE predicate, so Postgres rejected the upsert with
  // "no unique or exclusion constraint matching". seenEntryIds above
  // already filters out items whose qid is on the ticket, and the
  // suffix logic above disambiguates in-batch collisions, so no
  // conflict resolution is needed at the DB level.
  const { error: insErr } = await supabase
    .from('ticket_items')
    .insert(itemRows);
  if (insErr) {
    console.warn('[tickets] appendItemsToTicket items insert:', insErr.message);
    return null;
  }

  // Record tombstone tuples for every line we just inserted that had a
  // queue_entry_id. Future trigger fires (and future client-side calls)
  // will skip these tuples, so if the cashier later deletes the line
  // it stays deleted. Items without a queueEntryId are manual cashier
  // adds and don't get tombstones — their lifecycle is fully under the
  // cashier's control via TicketModal.
  const newTombstones = Array.from(
    new Set(
      toInsert
        .map((it) => tombstoneKey(it.queueEntryId ?? null, it.name))
        .filter((k): k is string => !!k),
    ),
  );
  if (newTombstones.length > 0) {
    const merged = Array.from(new Set([...attributed, ...newTombstones]));
    const { error: tsErr } = await supabase
      .from('tickets')
      .update({ auto_attributed_sources: merged })
      .eq('id', ticketId)
      .eq('status', 'open');
    if (tsErr) {
      console.warn('[tickets] appendItemsToTicket tombstone update:', tsErr.message);
    }
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
 * Reconcile a single queue entry's ticket lines to match the entry's CURRENT
 * services + assigned manicurist. Used by syncQueue so that edits made to a
 * client in the queue (added/removed/renamed services, reassigned staff,
 * request changes) flow into the matching open ticket in the register
 * without the cashier having to manually re-add the service at checkout.
 *
 * Scope: ONLY touches ticket_items rows whose `queue_entry_id` is `entry.id`
 * or `entry.id#svc<idx>`. Manually-added cashier lines, retail, gift card
 * sales — anything not tagged with this entry's queue_entry_id — is left
 * alone.
 *
 * Cashier-friendly: existing items are updated in place when the same slot
 * still maps to a desired service, so the cashier's `unit_price_cents` and
 * `discount_cents` overrides survive a queue edit. Only new services get the
 * catalog price applied; renamed lines keep whatever override was on them.
 *
 * Returns true if anything on the ticket changed (used by callers for logs).
 * Silently no-ops if the entry has no assigned manicurist (no ticket yet)
 * or if the ticket is closed/voided (don't touch settled work).
 */
export async function syncEntryToTicket(
  entry: {
    id: string;
    parentQueueId?: string | null;
    services: string[];
    serviceRequests?: Array<{ service: string; manicuristIds: string[] }>;
    assignedManicuristId: string | null;
  },
  manicurists: Array<{ id: string; name: string; color: string }>,
  salonServices: Array<{ id: string; name: string; price: number }>,
): Promise<boolean> {
  if (!entry.assignedManicuristId) return false;

  // Normalize via getVisitId so deeper sibling entries (whose
  // parentQueueId carries `-waiting` suffixes) still resolve to the root.
  const visitId = getVisitId(entry.parentQueueId ?? entry.id);

  const { data: tRow, error: tErr } = await supabase
    .from('tickets')
    .select('id, status, primary_manicurist_id, discount_cents, tax_cents, tip_cents')
    .eq('queue_entry_id', visitId)
    .eq('status', 'open')
    .maybeSingle();
  if (tErr) {
    console.warn('[tickets] syncEntryToTicket find ticket:', tErr.message);
    return false;
  }
  if (!tRow) return false;
  const ticket = tRow as {
    id: string;
    status: string;
    primary_manicurist_id: string | null;
    discount_cents: number;
    tax_cents: number;
    tip_cents: number;
  };

  // All existing ticket_items rows for THIS entry. Matched by prefix so
  // both `entry.id` (single-service entries) and `entry.id#svc<idx>`
  // (multi-service or split-multi) come back together.
  type ItemRow = {
    id: string;
    queue_entry_id: string | null;
    name: string;
    service_id: string | null;
    staff1_id: string | null;
    staff2_id: string | null;
    unit_price_cents: number;
    ext_price_cents: number;
    quantity: number;
    discount_cents: number;
    sort_order: number;
  };
  const { data: itemRows, error: iErr } = await supabase
    .from('ticket_items')
    .select('id, queue_entry_id, name, service_id, staff1_id, staff2_id, unit_price_cents, ext_price_cents, quantity, discount_cents, sort_order')
    .eq('ticket_id', ticket.id)
    .like('queue_entry_id', `${entry.id}%`);
  if (iErr) {
    console.warn('[tickets] syncEntryToTicket items fetch:', iErr.message);
    return false;
  }
  const existing = (itemRows ?? []) as ItemRow[];

  // Resolve the entry's assigned manicurist (used as the per-line staff
  // when no per-service request override exists).
  const assignedM = manicurists.find((m) => m.id === entry.assignedManicuristId) ?? null;

  type Desired = {
    name: string;
    serviceId: string | null;
    staff1Id: string | null;
    staff1Name: string;
    staff1Color: string;
    queueEntryId: string;
    catalogUnitPriceCents: number;
  };
  const desired: Desired[] = entry.services.map((svcName, idx) => {
    const svc = salonServices.find((s) => s.name === svcName);
    const sr = (entry.serviceRequests ?? []).find((r) => r.service === svcName);
    const lineMid = sr?.manicuristIds?.[0] ?? assignedM?.id ?? null;
    const lineM = lineMid ? manicurists.find((mm) => mm.id === lineMid) ?? null : assignedM;
    return {
      name: svcName,
      serviceId: svc?.id ?? null,
      staff1Id: lineM?.id ?? null,
      staff1Name: lineM?.name ?? '',
      staff1Color: lineM?.color ?? '#9ca3af',
      queueEntryId: entry.services.length > 1 ? `${entry.id}#svc${idx}` : entry.id,
      catalogUnitPriceCents: Math.round((svc?.price ?? 0) * 100),
    };
  });

  // Greedy match — try queue_entry_id slot first (exact), then service
  // name, then any unused existing row (covers wholesale rename / staff
  // swap cases). usedExisting prevents the same row matching twice.
  const usedExisting = new Set<string>();
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const inserts: Array<Record<string, unknown>> = [];
  let nextSortOrder = existing.reduce((mx, r) => Math.max(mx, r.sort_order ?? 0), 0) + 1;

  for (const d of desired) {
    let match: ItemRow | undefined =
      existing.find((e) => !usedExisting.has(e.id) && e.queue_entry_id === d.queueEntryId);
    if (!match) match = existing.find((e) => !usedExisting.has(e.id) && e.name === d.name);
    if (!match) match = existing.find((e) => !usedExisting.has(e.id));

    if (match) {
      usedExisting.add(match.id);
      const patch: Record<string, unknown> = {};
      if (match.name !== d.name) {
        patch.name = d.name;
        patch.service_id = d.serviceId;
        // Preserve the cashier's `unit_price_cents` override. If they
        // discounted the line at checkout we don't want a queue rename
        // resetting them to catalog price.
      }
      if (match.staff1_id !== d.staff1Id) {
        patch.staff1_id = d.staff1Id;
        patch.staff1_name = d.staff1Name;
        patch.staff1_color = d.staff1Color;
      }
      if (match.queue_entry_id !== d.queueEntryId) {
        patch.queue_entry_id = d.queueEntryId;
      }
      if (Object.keys(patch).length > 0) {
        updates.push({ id: match.id, patch });
      }
    } else {
      // New service line — use catalog price; cashier can adjust later.
      inserts.push({
        ticket_id: ticket.id,
        kind: 'service',
        name: d.name,
        service_id: d.serviceId,
        staff1_id: d.staff1Id,
        staff1_name: d.staff1Name,
        staff1_color: d.staff1Color,
        staff2_id: null,
        staff2_name: '',
        staff2_color: '#9ca3af',
        unit_price_cents: d.catalogUnitPriceCents,
        quantity: 1,
        discount_cents: 0,
        ext_price_cents: Math.max(0, d.catalogUnitPriceCents),
        sort_order: nextSortOrder++,
        queue_entry_id: d.queueEntryId,
      });
    }
  }

  // Anything in `existing` that didn't get matched is a removed service.
  const deletes = existing.filter((e) => !usedExisting.has(e.id)).map((e) => e.id);

  let changed = false;
  for (const u of updates) {
    const { error } = await supabase.from('ticket_items').update(u.patch).eq('id', u.id);
    if (error) {
      console.error('[tickets] syncEntryToTicket update:', error.message);
      return false;
    }
    changed = true;
  }
  if (inserts.length > 0) {
    // Plain INSERT — the previous upsert used `onConflict: 'ticket_id,
    // queue_entry_id'` but the underlying unique index is PARTIAL
    // (WHERE queue_entry_id IS NOT NULL), and Supabase JS doesn't pass
    // the WHERE predicate, so Postgres rejected with "no unique or
    // exclusion constraint matching the ON CONFLICT specification".
    // The desired-line builder above gives each insert a distinct
    // queue_entry_id (`${entry.id}#svc{idx}` for multi-service, or
    // entry.id for single-service), so in-batch collisions can't happen.
    const { error } = await supabase
      .from('ticket_items')
      .insert(inserts);
    if (error) {
      console.error('[tickets] syncEntryToTicket insert:', error.message);
      return false;
    }
    changed = true;
  }
  if (deletes.length > 0) {
    const { error } = await supabase.from('ticket_items').delete().in('id', deletes);
    if (error) {
      console.error('[tickets] syncEntryToTicket delete:', error.message);
      return false;
    }
    changed = true;
  }

  // Backfill the ticket's primary manicurist if this entry IS the primary
  // visit AND the ticket either has no primary yet, or the previous primary
  // matched the staff this entry was reassigned away from. Conservative —
  // we never overwrite a cashier-picked primary that doesn't match either.
  if (assignedM) {
    const isPrimaryVisit = (entry.parentQueueId ?? entry.id) === visitId;
    if (isPrimaryVisit) {
      const cur = ticket.primary_manicurist_id;
      const oldStaffIds = new Set(existing.map((e) => e.staff1_id).filter((x): x is string => !!x));
      if (!cur || (cur !== assignedM.id && oldStaffIds.has(cur))) {
        const { error } = await supabase
          .from('tickets')
          .update({
            primary_manicurist_id: assignedM.id,
            primary_manicurist_name: assignedM.name,
            primary_manicurist_color: assignedM.color,
          })
          .eq('id', ticket.id)
          .eq('status', 'open');
        if (error) {
          console.warn('[tickets] syncEntryToTicket primary update:', error.message);
        } else {
          changed = true;
        }
      }
    }
  }

  if (!changed) return false;

  // Recompute subtotal + total from current items.
  const { data: freshItems } = await supabase
    .from('ticket_items')
    .select('unit_price_cents, quantity, discount_cents')
    .eq('ticket_id', ticket.id);
  const subtotal = ((freshItems ?? []) as Array<{ unit_price_cents: number; quantity: number; discount_cents: number }>)
    .reduce((s, it) => s + Math.max(0, it.unit_price_cents * it.quantity - it.discount_cents), 0);
  const total = Math.max(
    0,
    subtotal - (ticket.discount_cents ?? 0) + (ticket.tax_cents ?? 0) + (ticket.tip_cents ?? 0),
  );
  const { error: uErr } = await supabase
    .from('tickets')
    .update({ subtotal_cents: subtotal, total_cents: total, updated_at: new Date().toISOString() })
    .eq('id', ticket.id)
    .eq('status', 'open');
  if (uErr) {
    console.warn('[tickets] syncEntryToTicket totals update:', uErr.message);
  }

  return true;
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
    // Each item needs a DISTINCT queue_entry_id within the batch — otherwise
    // the partial unique index `uniq_ticket_items_per_entry (ticket_id,
    // queue_entry_id) WHERE queue_entry_id IS NOT NULL` will reject the
    // 2nd+ rows. Strategy:
    //   - If the caller supplied a per-item queueEntryId, use it as-is.
    //   - Otherwise fall back to the ticket-level input.queueEntryId, but
    //     suffix multi-item batches with `#<idx>` so each line has its own
    //     unique key (same convention the DB trigger uses).
    //   - If input.queueEntryId is also null (the rare unattached-walk-in
    //     case), pass null and rely on the partial-index's WHERE predicate
    //     to skip uniqueness entirely.
    const baseQe = input.queueEntryId ?? null;
    const multi = input.items.length > 1;
    const itemRows = input.items.map((it, idx) => {
      let qe: string | null;
      if (it.queueEntryId != null) {
        qe = it.queueEntryId;
      } else if (baseQe != null) {
        qe = multi ? `${baseQe}#${idx + 1}` : baseQe;
      } else {
        qe = null;
      }
      return {
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
        queue_entry_id: qe,
      };
    });

    // Plain INSERT — no ON CONFLICT clause. The unique index on
    // (ticket_id, queue_entry_id) is PARTIAL (WHERE queue_entry_id IS NOT
    // NULL) and Supabase JS's `onConflict` option does not pass the WHERE
    // predicate, so Postgres rejects with "no unique or exclusion
    // constraint matching the ON CONFLICT specification". Plain insert
    // works because:
    //   - The ticket is freshly created above, so there are no existing
    //     ticket_items rows to conflict with.
    //   - We just guaranteed each input row has a distinct queue_entry_id
    //     within the batch (or queue_entry_id IS NULL, which the partial
    //     index doesn't enforce).
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
    // Original queue_entry_id snapshot — passed through so save round-trips
    // don't drop the link back to completed_services. Without this, edits
    // that delete+reinsert items lose the visit-id binding and downstream
    // sync (turn counts, requested flag) can't find the matching row.
    queueEntryId?: string | null;
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
      // Two or more items in the batch can legitimately want the same
      // queue_entry_id (TicketModal heals null qids to the ticket-level
      // qid, so a freshly-added service line collides with the original).
      // The partial unique index `uniq_ticket_items_per_entry` on
      // (ticket_id, queue_entry_id) WHERE queue_entry_id IS NOT NULL
      // rejects the second insert — DELETE has already committed, so
      // the ticket ends up with zero items but the old header total.
      // Disambiguate by suffixing collisions with `#N` (same pattern the
      // DB trigger uses for multi-service rows). NULL qids skip this
      // entirely since the partial index doesn't enforce uniqueness
      // when the column is null.
      const qeOccurrences = new Map<string, number>();
      for (const it of input.items) {
        if (it.queueEntryId != null) {
          qeOccurrences.set(it.queueEntryId, (qeOccurrences.get(it.queueEntryId) ?? 0) + 1);
        }
      }
      const qeUsed = new Map<string, number>();
      const rows = input.items.map((it, idx) => {
        let qe: string | null = it.queueEntryId ?? null;
        if (qe != null && (qeOccurrences.get(qe) ?? 0) > 1) {
          const used = (qeUsed.get(qe) ?? 0) + 1;
          qeUsed.set(qe, used);
          qe = `${qe}#${used}`;
        }
        return {
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
          // Carry the visit-id binding through delete+reinsert cycles so
          // downstream sync (completed_services lookup) still works.
          queue_entry_id: qe,
        };
      });
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
export async function voidTicket(
  ticketId: string,
  reason: string,
  receptionistId?: string | null,
): Promise<boolean> {
  const { error } = await supabase
    .from('tickets')
    .update({
      status: 'voided',
      void_reason: reason,
      closed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      voided_by_receptionist_id: receptionistId ?? null,
    })
    .eq('id', ticketId)
    .eq('status', 'open');
  if (error) {
    console.error('[tickets] voidTicket:', error.message);
    return false;
  }

  // Strip the corresponding completed_services rows. Without this, voided
  // services keep showing up on staff portal lists (e.g. Kelly seeing
  // Gina/Gggina/Silvia after their tickets were voided as duplicates).
  // Match by ticket_items.queue_entry_id; some ids carry a `#svc<n>`
  // suffix for multi-service entries — strip that before matching the
  // base completed_services row.
  try {
    const { data: itemRows, error: iErr } = await supabase
      .from('ticket_items')
      .select('queue_entry_id')
      .eq('ticket_id', ticketId);
    if (iErr) {
      console.warn('[tickets] voidTicket items fetch:', iErr.message);
    } else {
      const queueIds = new Set<string>();
      for (const r of (itemRows ?? []) as Array<{ queue_entry_id: string | null }>) {
        if (!r.queue_entry_id) continue;
        const base = r.queue_entry_id.split('#')[0];
        queueIds.add(base);
      }
      if (queueIds.size > 0) {
        const { error: delErr } = await supabase
          .from('completed_services')
          .delete()
          .in('id', Array.from(queueIds));
        if (delErr) {
          console.warn('[tickets] voidTicket completed_services delete:', delErr.message);
        }
      }
    }
  } catch (err) {
    console.warn('[tickets] voidTicket cleanup unexpected:', err);
  }

  return true;
}

/**
 * When a cashier changes the staff on a ticket line at checkout, the turn
 * credit should follow the work — the old assignee gives up their turn,
 * the new assignee earns it. Same logic regardless of whether they were
 * requested, walk-in, or part of a split visit.
 *
 * For each (queueEntryId, oldStaffId, newStaffId) tuple:
 *   1. Look up the matching completed_services row to get the turn_value.
 *   2. Decrement totalTurns on oldStaffId, increment on newStaffId.
 *   3. Repoint completed_services.manicurist_id (+ name + color) to the
 *      new staff so reports attribute the work correctly.
 *
 * Skips entries where the queue_entry_id is null or the staff didn't
 * actually change (caller pre-filters).
 */
export async function reallocateTurnsForStaffChanges(
  changes: Array<{
    queueEntryId: string;
    oldStaffId: string | null;
    newStaffId: string | null;
    newStaffName: string;
    newStaffColor: string;
  }>,
): Promise<void> {
  for (const c of changes) {
    if (!c.queueEntryId) continue;
    if (c.oldStaffId === c.newStaffId) continue;
    try {
      const { data: completed, error: cErr } = await supabase
        .from('completed_services')
        .select('id, turn_value, manicurist_id')
        .eq('id', c.queueEntryId)
        .maybeSingle();
      if (cErr || !completed) continue;
      const turn = Number((completed as { turn_value: number }).turn_value) || 0;

      // Decrement the old staff's totalTurns (when known).
      if (c.oldStaffId) {
        const { data: oldRow } = await supabase
          .from('manicurists').select('total_turns').eq('id', c.oldStaffId).maybeSingle();
        const oldTurns = Math.max(0, Number((oldRow as { total_turns?: number } | null)?.total_turns ?? 0) - turn);
        await supabase.from('manicurists').update({ total_turns: oldTurns }).eq('id', c.oldStaffId);
      }
      // Increment the new staff's totalTurns.
      if (c.newStaffId) {
        const { data: newRow } = await supabase
          .from('manicurists').select('total_turns').eq('id', c.newStaffId).maybeSingle();
        const newTurns = Number((newRow as { total_turns?: number } | null)?.total_turns ?? 0) + turn;
        await supabase.from('manicurists').update({ total_turns: newTurns }).eq('id', c.newStaffId);
      }
      // Repoint the completed_services row.
      await supabase.from('completed_services').update({
        manicurist_id: c.newStaffId,
        manicurist_name: c.newStaffName,
        manicurist_color: c.newStaffColor,
      }).eq('id', c.queueEntryId);
    } catch (err) {
      console.warn('[tickets] reallocateTurnsForStaffChanges failed for', c.queueEntryId, err);
    }
  }
}

// replace payments on a closed ticket --------------------------------------

/**
 * Wholesale replacement of a closed ticket's payments. Used by the
 * receptionist-edit flow when a payment method or split needs to be corrected
 * after checkout (e.g. customer paid card but it was recorded as gift).
 *
 * Deletes the existing non-refund rows, inserts the supplied set, and
 * re-derives `tickets.paid_cents` from the sum.
 */
export async function replaceTicketPayments(
  ticketId: string,
  newPayments: Array<{ method: 'cash' | 'visa_mc' | 'gift'; amountCents: number; giftCardCode?: string | null }>,
): Promise<boolean> {
  // Pull shift_id from the ticket so the new rows stay attached to the
  // same shift the original payments belonged to.
  const { data: tr, error: tErr } = await supabase
    .from('tickets')
    .select('shift_id')
    .eq('id', ticketId)
    .maybeSingle();
  if (tErr || !tr) { console.error('[tickets] replaceTicketPayments read ticket:', tErr?.message ?? 'not found'); return false; }
  const shiftId = (tr as { shift_id: string | null }).shift_id;

  // Drop existing non-refund payments. Refund rows are preserved as audit.
  const { error: dErr } = await supabase
    .from('payments')
    .delete()
    .eq('ticket_id', ticketId)
    .is('refund_of', null);
  if (dErr) { console.error('[tickets] replaceTicketPayments delete:', dErr.message); return false; }

  if (newPayments.length > 0) {
    // Several columns on `payments` are NOT NULL with text defaults (''):
    // gift_card_code, processor, processor_payment_id, card_brand, card_last4.
    // Send empty strings, not nulls, so the defaults apply and inserts don't
    // trip the NOT NULL constraint. tendered_cents / change_cents are
    // nullable; we leave tendered as null for non-cash receptionist edits.
    const rows = newPayments.map((p) => ({
      ticket_id: ticketId,
      shift_id: shiftId,
      method: p.method,
      amount_cents: p.amountCents,
      tendered_cents: null,
      change_cents: 0,
      gift_card_code: p.giftCardCode ?? '',
      processor: 'manual',
      processor_payment_id: '',
      card_brand: '',
      card_last4: '',
      refund_of: null,
      captured_at: new Date().toISOString(),
    }));
    const { error: iErr } = await supabase.from('payments').insert(rows);
    if (iErr) { console.error('[tickets] replaceTicketPayments insert:', iErr.message); return false; }
  }

  // Re-derive paid_cents on the parent ticket from the new payment set.
  const paidCents = newPayments.reduce((s, p) => s + p.amountCents, 0);
  const { error: uErr } = await supabase
    .from('tickets')
    .update({ paid_cents: paidCents })
    .eq('id', ticketId);
  if (uErr) { console.error('[tickets] replaceTicketPayments update paid:', uErr.message); return false; }

  return true;
}

// update payment ----------------------------------------------------------

/**
 * Adjust a recorded payment's amount before shift close. Used by the
 * Cash/Card/Gift transaction tabs on the Close Shift surface so receptionists
 * can fix mis-entered amounts without voiding and re-tendering.
 *
 * For cash payments, `tenderedCents` is left intact (it represents what the
 * customer physically handed over) and `changeCents` is recomputed as
 * max(0, tendered - amount) so the drawer math stays consistent.
 *
 * After updating the row, the parent ticket's `paid_cents` is re-derived
 * from the sum of every non-refund payment so totals don't drift.
 */
export async function updatePayment(
  paymentId: string,
  newAmountCents: number,
): Promise<boolean> {
  // 1. Read the existing row to know which ticket + tendered amount apply.
  const { data: existing, error: rErr } = await supabase
    .from('payments')
    .select('id, ticket_id, method, tendered_cents')
    .eq('id', paymentId)
    .maybeSingle();
  if (rErr || !existing) {
    console.error('[tickets] updatePayment read:', rErr?.message ?? 'not found');
    return false;
  }
  const row = existing as { id: string; ticket_id: string; method: 'cash' | 'visa_mc' | 'gift'; tendered_cents: number | null };

  // 2. Update the payment row.
  const patch: Record<string, number | null> = { amount_cents: newAmountCents };
  if (row.method === 'cash' && row.tendered_cents != null) {
    patch.change_cents = Math.max(0, row.tendered_cents - newAmountCents);
  }
  const { error: uErr } = await supabase.from('payments').update(patch).eq('id', paymentId);
  if (uErr) {
    console.error('[tickets] updatePayment update:', uErr.message);
    return false;
  }

  // 3. Re-derive paid_cents on the parent ticket from every non-refund row
  //    so totals don't drift after the amount change.
  const { data: allPays, error: aErr } = await supabase
    .from('payments')
    .select('amount_cents, refund_of')
    .eq('ticket_id', row.ticket_id);
  if (aErr) {
    console.error('[tickets] updatePayment re-sum:', aErr.message);
    return false;
  }
  const paidCents = ((allPays ?? []) as Array<{ amount_cents: number; refund_of: string | null }>)
    .filter((p) => p.refund_of == null)
    .reduce((s, p) => s + (p.amount_cents ?? 0), 0);

  const { error: tErr } = await supabase
    .from('tickets')
    .update({ paid_cents: paidCents })
    .eq('id', row.ticket_id);
  if (tErr) {
    console.error('[tickets] updatePayment ticket paid_cents:', tErr.message);
    return false;
  }

  return true;
}

/**
 * Brute-force dedupe pass: ensure a single-service queue entry has AT MOST
 * one ticket line, and that line's staff matches the entry's current
 * assigned manicurist.
 *
 * Why this exists: a cancel-then-reassign flow that happens to fall between
 * a sibling-reconcile pass and a justAssigned-auto-create pass can produce a
 * ticket with both the OLD staff's line (still tagged with the original
 * entry id) AND a NEW line for the reassigned staff (tagged with the same
 * entry id but suffixed `#1` by appendItemsToTicket's in-batch collision
 * logic). The regular syncEntryToTicket pass deletes whichever line wasn't
 * matched, but races between writes can leave the deleted-then-resurrected
 * variant on the ticket. This function is a last-line-of-defense that runs
 * at the very end of syncQueue and converges every visible duplicate to a
 * single canonical line per entry.
 *
 * Returns the number of duplicate lines deleted.
 */
export async function cleanupDuplicateLinesForEntry(
  entry: {
    id: string;
    services: string[];
    assignedManicuristId: string | null;
    parentQueueId?: string | null;
  },
  manicurists: Array<{ id: string; name: string; color: string }>,
): Promise<number> {
  if (!entry.assignedManicuristId) return 0;
  if (!entry.services || entry.services.length !== 1) return 0; // multi-svc has legit `#svcN` siblings — skip

  const visitId = getVisitId(entry.parentQueueId ?? entry.id);
  const { data: tRow, error: tErr } = await supabase
    .from('tickets')
    .select('id, discount_cents, tax_cents, tip_cents')
    .eq('queue_entry_id', visitId)
    .eq('status', 'open')
    .maybeSingle();
  if (tErr || !tRow) return 0;
  const ticket = tRow as { id: string; discount_cents: number; tax_cents: number; tip_cents: number };

  const { data: rows, error: iErr } = await supabase
    .from('ticket_items')
    .select('id, queue_entry_id, staff1_id, name, sort_order, unit_price_cents, quantity, discount_cents')
    .eq('ticket_id', ticket.id)
    .like('queue_entry_id', `${entry.id}%`);
  if (iErr || !rows) return 0;
  type Row = {
    id: string;
    queue_entry_id: string | null;
    staff1_id: string | null;
    name: string;
    sort_order: number;
    unit_price_cents: number;
    quantity: number;
    discount_cents: number;
  };
  const items = (rows ?? []) as Row[];
  if (items.length <= 1) return 0;

  const assignedM = manicurists.find((m) => m.id === entry.assignedManicuristId);
  if (!assignedM) return 0;

  // Choose the keeper:
  //   1. Bare-qid line (entry.id with no suffix) — canonical form.
  //   2. If none, the line whose staff matches the current assigned manicurist.
  //   3. Else the lowest sort_order.
  const byBareQid = items.find((it) => it.queue_entry_id === entry.id);
  const byMatchingStaff = items.find((it) => it.staff1_id === assignedM.id);
  const byFirstSort = [...items].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))[0];
  const keeper = byBareQid ?? byMatchingStaff ?? byFirstSort;
  if (!keeper) return 0;

  const toDelete = items.filter((it) => it.id !== keeper.id);
  if (toDelete.length === 0) return 0;

  const { error: dErr } = await supabase
    .from('ticket_items')
    .delete()
    .in('id', toDelete.map((it) => it.id));
  if (dErr) {
    console.warn('[tickets] cleanupDuplicateLinesForEntry delete:', dErr.message);
    return 0;
  }

  // Normalize the keeper: bare qid + correct staff.
  const patch: Record<string, unknown> = {};
  if (keeper.queue_entry_id !== entry.id) patch.queue_entry_id = entry.id;
  if (keeper.staff1_id !== assignedM.id) {
    patch.staff1_id = assignedM.id;
    patch.staff1_name = assignedM.name;
    patch.staff1_color = assignedM.color;
  }
  if (Object.keys(patch).length > 0) {
    const { error: uErr } = await supabase.from('ticket_items').update(patch).eq('id', keeper.id);
    if (uErr) {
      console.warn('[tickets] cleanupDuplicateLinesForEntry update keeper:', uErr.message);
    }
  }

  // Recompute the ticket's subtotal/total from the surviving items.
  const { data: freshItems } = await supabase
    .from('ticket_items')
    .select('unit_price_cents, quantity, discount_cents')
    .eq('ticket_id', ticket.id);
  const subtotal = ((freshItems ?? []) as Array<{ unit_price_cents: number; quantity: number; discount_cents: number }>)
    .reduce((s, it) => s + Math.max(0, it.unit_price_cents * it.quantity - it.discount_cents), 0);
  const total = Math.max(
    0,
    subtotal - (ticket.discount_cents ?? 0) + (ticket.tax_cents ?? 0) + (ticket.tip_cents ?? 0),
  );
  await supabase
    .from('tickets')
    .update({ subtotal_cents: subtotal, total_cents: total, updated_at: new Date().toISOString() })
    .eq('id', ticket.id)
    .eq('status', 'open');

  return toDelete.length;
}
