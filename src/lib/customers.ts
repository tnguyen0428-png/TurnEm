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
      first_name: input.firstName.trim(),
      last_name: input.lastName.trim(),
      phone: input.phone.trim(),
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
      first_name: input.firstName.trim(),
      last_name: input.lastName.trim(),
      phone: input.phone.trim(),
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
