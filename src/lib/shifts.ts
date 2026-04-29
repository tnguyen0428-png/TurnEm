// Shift (drawer session) data layer.
//
// A shift is a drawer session: opened with a starting cash amount, accumulates
// cash payments + drawer pay-ins/pay-outs through the day, then closed with a
// declared count and variance against expected. End-of-day balance reads from
// here.

import { supabase } from './supabase';
import { getTodayLA } from '../utils/time';
import type { Shift, ShiftMovement } from '../types';

interface DbShift {
  id: string;
  business_date: string;
  drawer_number: number;
  status: Shift['status'];
  opened_at: string;
  opening_cash_cents: number;
  closed_at: string | null;
  expected_cash_cents: number | null;
  declared_cash_cents: number | null;
  variance_cents: number | null;
  variance_note: string;
  opening_count: Record<string, number>;
  closing_count: Record<string, number>;
}

interface DbShiftMovement {
  id: string;
  shift_id: string;
  kind: ShiftMovement['kind'];
  amount_cents: number;
  reason: string;
  created_at: string;
}

function fromDbShift(row: DbShift): Shift {
  return {
    id: row.id,
    businessDate: row.business_date,
    drawerNumber: row.drawer_number,
    status: row.status,
    openedAt: new Date(row.opened_at).getTime(),
    openingCashCents: row.opening_cash_cents,
    closedAt: row.closed_at ? new Date(row.closed_at).getTime() : null,
    expectedCashCents: row.expected_cash_cents,
    declaredCashCents: row.declared_cash_cents,
    varianceCents: row.variance_cents,
    varianceNote: row.variance_note,
    openingCount: (row.opening_count ?? {}) as Record<string, number>,
    closingCount: (row.closing_count ?? {}) as Record<string, number>,
  };
}

function fromDbMovement(row: DbShiftMovement): ShiftMovement {
  return {
    id: row.id,
    shiftId: row.shift_id,
    kind: row.kind,
    amountCents: row.amount_cents,
    reason: row.reason,
    createdAt: new Date(row.created_at).getTime(),
  };
}

// ── reads ────────────────────────────────────────────────────────────────────

export async function fetchOpenShift(): Promise<Shift | null> {
  const { data, error } = await supabase
    .from('shifts')
    .select('*')
    .eq('status', 'open')
    .order('opened_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) { console.error('[shifts] fetchOpenShift:', error.message); return null; }
  return data ? fromDbShift(data as DbShift) : null;
}

export async function fetchShift(shiftId: string): Promise<Shift | null> {
  const { data, error } = await supabase
    .from('shifts')
    .select('*')
    .eq('id', shiftId)
    .maybeSingle();
  if (error) { console.error('[shifts] fetchShift:', error.message); return null; }
  return data ? fromDbShift(data as DbShift) : null;
}

export async function fetchShiftsForDate(dateLA: string): Promise<Shift[]> {
  const { data, error } = await supabase
    .from('shifts')
    .select('*')
    .eq('business_date', dateLA)
    .order('opened_at', { ascending: false });
  if (error) { console.error('[shifts] fetchShiftsForDate:', error.message); return []; }
  return (data ?? []).map((r) => fromDbShift(r as DbShift));
}

export async function fetchShiftMovements(shiftId: string): Promise<ShiftMovement[]> {
  const { data, error } = await supabase
    .from('shift_movements')
    .select('*')
    .eq('shift_id', shiftId)
    .order('created_at', { ascending: true });
  if (error) { console.error('[shifts] fetchShiftMovements:', error.message); return []; }
  return (data ?? []).map((r) => fromDbMovement(r as DbShiftMovement));
}

// ── writes ───────────────────────────────────────────────────────────────────

export async function openShift(openingCashCents: number, openingCount: Record<string, number> = {}): Promise<Shift | null> {
  const existing = await fetchOpenShift();
  if (existing) {
    console.warn('[shifts] openShift: a shift is already open', existing.id);
    return existing;
  }
  const { data, error } = await supabase
    .from('shifts')
    .insert({
      business_date: getTodayLA(),
      drawer_number: 1,
      status: 'open',
      opening_cash_cents: openingCashCents,
      opening_count: openingCount,
    })
    .select('*')
    .single();
  if (error) { console.error('[shifts] openShift:', error.message); return null; }
  return fromDbShift(data as DbShift);
}

export async function addShiftMovement(input: {
  shiftId: string;
  kind: ShiftMovement['kind'];
  amountCents: number;
  reason: string;
}): Promise<ShiftMovement | null> {
  const { data, error } = await supabase
    .from('shift_movements')
    .insert({
      shift_id: input.shiftId,
      kind: input.kind,
      amount_cents: Math.abs(input.amountCents),
      reason: input.reason,
    })
    .select('*')
    .single();
  if (error) { console.error('[shifts] addShiftMovement:', error.message); return null; }
  return fromDbMovement(data as DbShiftMovement);
}

// ── close-shift balance computation ──────────────────────────────────────────

export interface ShiftBalanceLine {
  method: 'cash' | 'visa_mc' | 'gift';
  startingBalanceCents: number;
  paymentCount: number;
  paymentAmountCents: number;
  changeOutCents: number;
  drawerEntriesCents: number;
  youHaveCents: number;
}

export async function computeShiftBalance(shiftId: string): Promise<{
  lines: ShiftBalanceLine[];
  expectedCashCents: number;
} | null> {
  const shift = await fetchShift(shiftId);
  if (!shift) return null;

  const [pRes, mRes] = await Promise.all([
    supabase.from('payments').select('method, amount_cents, change_cents').eq('shift_id', shiftId),
    supabase.from('shift_movements').select('kind, amount_cents').eq('shift_id', shiftId),
  ]);

  const payments = (pRes.data ?? []) as Array<{ method: ShiftBalanceLine['method']; amount_cents: number; change_cents: number | null }>;
  const movements = (mRes.data ?? []) as Array<{ kind: ShiftMovement['kind']; amount_cents: number }>;

  function lineFor(method: ShiftBalanceLine['method']): ShiftBalanceLine {
    const my = payments.filter((p) => p.method === method);
    const paymentAmountCents = my.reduce((s, p) => s + p.amount_cents, 0);
    const changeOutCents = method === 'cash' ? my.reduce((s, p) => s + (p.change_cents ?? 0), 0) : 0;
    const drawerEntriesCents =
      method === 'cash'
        ? movements.reduce((s, m) => s + (m.kind === 'pay_in' ? m.amount_cents : -m.amount_cents), 0)
        : 0;
    const startingBalanceCents = method === 'cash' ? (shift?.openingCashCents ?? 0) : 0;
    return {
      method,
      startingBalanceCents,
      paymentCount: my.length,
      paymentAmountCents,
      changeOutCents,
      drawerEntriesCents,
      youHaveCents: startingBalanceCents + paymentAmountCents - changeOutCents + drawerEntriesCents,
    };
  }

  const lines: ShiftBalanceLine[] = [lineFor('cash'), lineFor('visa_mc'), lineFor('gift')];
  const expectedCashCents = lines[0].youHaveCents;
  return { lines, expectedCashCents };
}

export async function closeShift(input: {
  shiftId: string;
  declaredCashCents: number;
  expectedCashCents: number;
  varianceNote?: string;
  closingCount?: Record<string, number>;
}): Promise<Shift | null> {
  const variance = input.declaredCashCents - input.expectedCashCents;
  const { data, error } = await supabase
    .from('shifts')
    .update({
      status: 'closed',
      closed_at: new Date().toISOString(),
      expected_cash_cents: input.expectedCashCents,
      declared_cash_cents: input.declaredCashCents,
      variance_cents: variance,
      variance_note: input.varianceNote ?? '',
      closing_count: input.closingCount ?? {},
    })
    .eq('id', input.shiftId)
    .select('*')
    .single();
  if (error) { console.error('[shifts] closeShift:', error.message); return null; }
  return fromDbShift(data as DbShift);
}
