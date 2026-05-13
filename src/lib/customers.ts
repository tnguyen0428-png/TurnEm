// Customers data layer — fetch / create / update / delete + history lookup
// against appointments, tickets, completed_services.
//
// Matching strategy: phone first (digits only, strict equality), then
// case-insensitive trimmed full name. A future migration adds customer_id
// FKs to the transactional tables; until then this JS join handles legacy
// data that pre-dates the customers table.

import { supabase } from './supabase';
import type { Appointment, Customer, Ticket } from '../types';

interface DbCustomer {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  notes: string;
  popup_note: string;
  created_at: string;
  updated_at: string;
}

function fromDb(row: DbCustomer): Customer {
  return {
    id: row.id,
    firstName: row.first_name ?? '',
    lastName: row.last_name ?? '',
    phone: row.phone ?? '',
    email: row.email ?? '',
    notes: row.notes ?? '',
    popupNote: row.popup_note ?? '',
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
  };
}

/** Digits-only phone for comparison. Empty input → empty string. */
export function normalizePhone(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '');
}

/** Full lowercased trimmed name for fallback matching. */
export function normalizeName(first: string, last: string): string {
  return `${first ?? ''} ${last ?? ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Build the display "First L." or "First Last" form for a customer record. */
export function displayCustomerName(c: Pick<Customer, 'firstName' | 'lastName'>): string {
  const f = c.firstName?.trim() ?? '';
  const l = c.lastName?.trim() ?? '';
  return [f, l].filter(Boolean).join(' ') || '(no name)';
}

/**
 * Title-case a name regardless of caps-lock input: "TONY" / "tony" / "tOnY"
 * all become "Tony". Treats spaces, hyphens, and apostrophes as word
 * boundaries so "mary-anne o'brien" → "Mary-Anne O'Brien".
 */
export function toTitleCase(raw: string): string {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s) return '';
  return s.replace(/(^|[\s\-'])(\p{L})/gu, (_m, sep, ch) => sep + ch.toUpperCase());
}

/**
 * Format a phone number as xxx-xxx-xxxx when 10 digits are present.
 * Anything else is returned as-is (preserves a partial entry the
 * receptionist may want to finish later).
 */
export function formatPhoneDashed(raw: string): string {
  const d = normalizePhone(raw);
  if (d.length !== 10) return (raw ?? '').trim();
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

export async function fetchCustomers(): Promise<Customer[]> {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .order('first_name', { ascending: true })
    .order('last_name', { ascending: true });
  if (error) { console.error('[customers] fetchCustomers:', error.message); return []; }
  return (data ?? []).map((r) => fromDb(r as DbCustomer));
}

export async function fetchCustomer(id: string): Promise<Customer | null> {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) { console.error('[customers] fetchCustomer:', error.message); return null; }
  return data ? fromDb(data as DbCustomer) : null;
}

export interface CustomerInput {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  notes: string;
  popupNote: string;
}

export async function createCustomer(input: CustomerInput): Promise<Customer | null> {
  const { data, error } = await supabase
    .from('customers')
    .insert({
      first_name: toTitleCase(input.firstName),
      last_name: toTitleCase(input.lastName),
      phone: formatPhoneDashed(input.phone),
      email: input.email.trim(),
      notes: input.notes,
      popup_note: input.popupNote,
    })
    .select('*')
    .single();
  if (error) { console.error('[customers] createCustomer:', error.message); return null; }
  return fromDb(data as DbCustomer);
}

export async function updateCustomer(id: string, input: CustomerInput): Promise<Customer | null> {
  const { data, error } = await supabase
    .from('customers')
    .update({
      first_name: toTitleCase(input.firstName),
      last_name: toTitleCase(input.lastName),
      phone: formatPhoneDashed(input.phone),
      email: input.email.trim(),
      notes: input.notes,
      popup_note: input.popupNote,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('*')
    .single();
  if (error) { console.error('[customers] updateCustomer:', error.message); return null; }
  return fromDb(data as DbCustomer);
}

export async function deleteCustomer(id: string): Promise<boolean> {
  const { error } = await supabase.from('customers').delete().eq('id', id);
  if (error) { console.error('[customers] deleteCustomer:', error.message); return false; }
  return true;
}

// ── History matching ─────────────────────────────────────────────────────────

export interface CustomerHistory {
  tickets: Ticket[];
  appointments: Appointment[];
  completedCount: number;
  totalSpentCents: number;
  lastVisitAt: number | null;
}

/**
 * Return matching tickets + appointments for a customer. Filters in JS:
 * phone first (digits-only equality), then full-name fallback. The caller
 * passes the full ticket/appointment caches to avoid extra round trips —
 * AppContext already keeps appointments in state, and tickets fetch in
 * the Sales report path.
 */
export function matchTickets(c: Customer, tickets: Ticket[]): Ticket[] {
  const phone = normalizePhone(c.phone);
  const fullName = normalizeName(c.firstName, c.lastName);
  return tickets.filter((t) => {
    if (phone && normalizePhone(t.clientPhone) === phone) return true;
    if (fullName && (t.clientName ?? '').trim().toLowerCase() === fullName) return true;
    return false;
  });
}

export function matchAppointments(c: Customer, appts: Appointment[]): Appointment[] {
  const phone = normalizePhone(c.phone);
  const fullName = normalizeName(c.firstName, c.lastName);
  return appts.filter((a) => {
    if (phone && normalizePhone(a.clientPhone) === phone) return true;
    if (fullName && (a.clientName ?? '').trim().toLowerCase() === fullName) return true;
    return false;
  });
}

/** Pull all tickets for the customer in one call so history view is one-shot. */
export async function fetchCustomerTickets(c: Customer): Promise<Ticket[]> {
  // Phone match (cheapest, most specific)
  const phone = normalizePhone(c.phone);
  const fullName = normalizeName(c.firstName, c.lastName);
  if (!phone && !fullName) return [];

  // Pull a moderate slice — newest 500 tickets and filter locally. This avoids
  // designing the perfect Postgres normalized-phone match query in v1.
  const { data, error } = await supabase
    .from('tickets')
    .select('*, items:ticket_items(*), payments:payments(*)')
    .order('opened_at', { ascending: false })
    .limit(500);
  if (error) { console.error('[customers] fetchCustomerTickets:', error.message); return []; }
  const rows = (data ?? []) as Array<{
    id: string; ticket_number: number; business_date: string;
    client_name: string; client_phone: string;
    total_cents: number; status: string; opened_at: string; closed_at: string | null;
    primary_manicurist_name: string;
    items: Array<{ name: string; staff1_name: string; ext_price_cents: number }>;
  }>;
  const filtered = rows.filter((t) => {
    if (phone && normalizePhone(t.client_phone) === phone) return true;
    if (fullName && (t.client_name ?? '').trim().toLowerCase() === fullName) return true;
    return false;
  });
  // We only need a thin Ticket shape here for display; the strict Ticket type
  // is heavy. Cast and let the caller treat returned values as readonly.
  return filtered as unknown as Ticket[];
}

/**
 * Split a combined "First Last Doe" string into a first + last pair on the
 * first space. Standalone helper so intake forms that still emit a single
 * clientName string can plumb through without UI changes.
 */
export function splitClientName(name: string): { firstName: string; lastName: string } {
  const s = (name ?? '').trim();
  if (!s) return { firstName: '', lastName: '' };
  const i = s.indexOf(' ');
  if (i === -1) return { firstName: s, lastName: '' };
  return { firstName: s.slice(0, i), lastName: s.slice(i + 1).trim() };
}

/**
 * Fire-and-forget upsert called from queue and appointment intake flows so
 * the Customer Profiles list auto-fills as the salon takes bookings.
 *
 * Matching: phone (digits-only equality) first, then full lowercased name.
 * Behavior on match: fill in blank fields (phone, email) but never overwrite
 * an already-populated value — receptionists are inconsistent about how
 * they type names, and we don't want a "Sara" intake to clobber a saved
 * "Sara Jane" record.
 *
 * Returns the resulting customer id, or null if both name + phone are empty
 * (we silently skip "Walk-in" entries with no identifying info).
 */
export async function upsertCustomerFromIntake(input: {
  firstName: string;
  lastName: string;
  phone?: string;
  email?: string;
}): Promise<string | null> {
  const first = (input.firstName ?? '').trim();
  const last = (input.lastName ?? '').trim();
  const phoneNorm = normalizePhone(input.phone ?? '');
  const fullName = normalizeName(first, last);
  const hasName = !!fullName && fullName !== 'walk-in';
  if (!phoneNorm && !hasName) return null;

  try {
    // Match phone + name together. Phone alone is NOT enough — a household
    // commonly shares one phone across multiple people (parents + kids on
    // one number) and matching on phone alone would silently merge their
    // profiles into the first one to use that number.
    //
    // Priority:
    //   1. phone match AND name match → same person (cheap + precise)
    //   2. phone match, missing name on existing → patch name onto it
    //   3. no phone match, name match → same person (legacy / phone-less)
    //   4. nothing → new profile
    let existing: Customer | null = null;
    if (phoneNorm) {
      const { data } = await supabase
        .from('customers')
        .select('*')
        .neq('phone', '')
        .limit(200);
      const rows = (data ?? []) as DbCustomer[];
      const samePhone = rows.filter((r) => normalizePhone(r.phone) === phoneNorm);
      // Exact name match within same-phone group → same person.
      const exactNameMatch = samePhone.find(
        (r) => normalizeName(r.first_name, r.last_name) === fullName,
      );
      if (exactNameMatch) {
        existing = fromDb(exactNameMatch);
      } else if (samePhone.length > 0) {
        // Phone matches but a record exists with a non-matching name (e.g.
        // family member). Look for a same-phone row whose name is BLANK
        // — that's a profile created without a name yet, safe to patch.
        const blankNameSibling = samePhone.find(
          (r) => normalizeName(r.first_name, r.last_name) === '',
        );
        if (blankNameSibling) existing = fromDb(blankNameSibling);
        // Otherwise leave existing=null and fall through to the create
        // path so Tony / Tria / Kayla each get their own row.
      }
    }
    if (!existing && hasName) {
      // No phone match (or no phone at all). Try a strict name match. This
      // catches phone-less walk-ins typed on the queue form.
      const { data } = await supabase
        .from('customers')
        .select('*')
        .ilike('first_name', `${first}%`)
        .limit(200);
      const rows = (data ?? []) as DbCustomer[];
      const match = rows.find(
        (r) => normalizeName(r.first_name, r.last_name) === fullName,
      );
      // Only treat as a match if the existing row has NO phone OR the same
      // phone — otherwise it's almost certainly a different "Sarah" at the
      // shop with a different number.
      if (match) {
        const existingPhone = normalizePhone(match.phone);
        if (!existingPhone || existingPhone === phoneNorm) {
          existing = fromDb(match);
        }
      }
    }

    if (existing) {
      // Only patch fields the existing record is missing — never overwrite.
      // Apply the same normalization rules (title case, dashed phone) on the
      // way in so a fresh intake fills a blank profile in the canonical form.
      const patch: Record<string, unknown> = {};
      if (!existing.phone && phoneNorm) patch.phone = formatPhoneDashed(input.phone ?? '');
      if (!existing.email && input.email) patch.email = input.email.trim();
      if (!existing.firstName && first) patch.first_name = toTitleCase(first);
      if (!existing.lastName && last) patch.last_name = toTitleCase(last);
      if (Object.keys(patch).length === 0) return existing.id;
      patch.updated_at = new Date().toISOString();
      const { error } = await supabase.from('customers').update(patch).eq('id', existing.id);
      if (error) console.warn('[customers] upsert patch failed:', error.message);
      return existing.id;
    }

    // 3. New profile.
    const { data, error } = await supabase
      .from('customers')
      .insert({
        first_name: toTitleCase(first),
        last_name: toTitleCase(last),
        phone: formatPhoneDashed(input.phone ?? ''),
        email: (input.email ?? '').trim(),
        notes: '',
        popup_note: '',
      })
      .select('id')
      .single();
    if (error) {
      console.warn('[customers] upsert insert failed:', error.message);
      return null;
    }
    return (data as { id: string }).id;
  } catch (err) {
    console.warn('[customers] upsertCustomerFromIntake unexpected error:', err);
    return null;
  }
}

/**
 * Live search across customers used by intake forms to surface an existing
 * profile while the receptionist types. Match priority:
 *   - phone digits substring (cheapest, most discriminating)
 *   - first_name OR last_name ILIKE substring
 * Returns up to `limit` rows ordered by recent updates so frequent visitors
 * float to the top.
 */
export async function searchCustomers(query: string, limit = 8): Promise<Customer[]> {
  const q = (query ?? '').trim();
  if (!q) return [];
  const phoneDigits = normalizePhone(q);
  let req = supabase.from('customers').select('*').limit(limit);
  if (phoneDigits.length >= 3) {
    // Phone match — column stores xxx-xxx-xxxx so a substring of just the
    // digits won't match. Allow either form by also OR'ing the ilike chain.
    req = req.or(`phone.ilike.%${phoneDigits}%,phone.ilike.%${q}%,first_name.ilike.%${q}%,last_name.ilike.%${q}%`);
  } else {
    req = req.or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%`);
  }
  const { data, error } = await req.order('updated_at', { ascending: false });
  if (error) { console.warn('[customers] searchCustomers:', error.message); return []; }
  return (data ?? []).map((r) => fromDb(r as DbCustomer));
}

