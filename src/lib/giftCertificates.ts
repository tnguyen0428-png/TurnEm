// giftCertificates — query layer for the Gift Certificates report.
//
// A gift cert is sold as a `ticket_items` row with kind='gift_card_sale'
// and a name like "Gift Certificate #00042". When it's later redeemed,
// the cashier enters that serial in the payment row, producing a
// `payments` row with method='gift' and gift_card_code='00042' (or
// '#00042', or '42' — cashiers are inconsistent, so we normalize on
// read).
//
// Open  = sold but no matching redemption.
// Used  = sold AND has at least one matching redemption.
//
// This module returns a flat row per sold cert with redemption fields
// populated when matched. Callers slice it into open vs used.

import { supabase } from './supabase';

export interface GiftCertificate {
  /** Serial as written on the sale line, e.g. "00042". */
  serial: string;
  /** Stripped form used for matching ("42" — no leading zeros, no "#"). */
  normalizedSerial: string;

  purchaseDate: string;          // YYYY-MM-DD (LA business date)
  purchasedAtMs: number;         // ticket.opened_at as ms epoch
  purchaseTicketId: string;
  purchaseTicketNumber: number;
  purchaseClientName: string;
  valueCents: number;

  // Redemption — null until the cert is used
  redeemedAtMs: number | null;
  redeemedDate: string | null;
  redeemedTicketId: string | null;
  redeemedTicketNumber: number | null;
  redeemedClientName: string | null;
  redeemedAmountCents: number | null;
}

interface DbSaleRow {
  id: string;
  name: string;
  ext_price_cents: number;
  ticket_id: string;
  tickets: {
    id: string;
    ticket_number: number;
    business_date: string;
    client_name: string;
    opened_at: string;
    status: string;
  } | null;
}

interface DbRedemptionRow {
  id: string;
  gift_card_code: string;
  amount_cents: number;
  captured_at: string;
  ticket_id: string;
  tickets: {
    id: string;
    ticket_number: number;
    business_date: string;
    client_name: string;
  } | null;
}

/** Strip leading "#" + leading zeros + whitespace. Empty string if nothing left. */
export function normalizeSerial(raw: string | null | undefined): string {
  // Strip a leading "#" and (for bare-digit SalonBiz serials) leading zeros.
  // Upper-case so the TurnEm "TM" prefix matches no matter how the cashier
  // typed it (tm10100 == TM10100). Bare-digit serials are unaffected.
  const s = (raw ?? '').trim().toUpperCase().replace(/^#/, '').replace(/^0+/, '');
  return s;
}

/** Extract the serial number from a gift_card_sale line item name. */
function serialFromLineName(name: string): { display: string; norm: string } {
  // TurnEm serials are "#TM<digits>" (e.g. #TM10100); imported SalonBiz
  // serials are bare "#<digits>". Prefer the TM form, then a plain "#digits",
  // then the first run of digits as a last resort.
  const m =
    name.match(/#(TM\d+)/i) ?? name.match(/#(\d+)/) ?? name.match(/(\d+)/);
  if (!m) return { display: '', norm: '' };
  const display = m[1];
  return { display, norm: normalizeSerial(display) };
}

/**
 * Pull every gift certificate ever sold + every redemption ever captured,
 * stitch them together by normalized serial, return flat rows for the
 * report. Salon volume is well below the point where loading the full
 * history hurts; if that ever changes we can window by purchase date.
 */
export async function fetchGiftCertificates(): Promise<GiftCertificate[]> {
  // Paginated reads: Supabase caps a single .select() at 1000 rows by
  // default, which silently truncated this report once we crossed the
  // threshold (SalonBiz import added 1900+ gift-cert sales).
  const PAGE = 1000;
  async function fetchAllSales(): Promise<DbSaleRow[]> {
    const out: DbSaleRow[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .from('ticket_items')
        .select('id, name, ext_price_cents, ticket_id, tickets(id, ticket_number, business_date, client_name, opened_at, status)')
        .eq('kind', 'gift_card_sale')
        .range(offset, offset + PAGE - 1);
      if (error) {
        console.error('[giftCertificates] sales:', error.message);
        return out;
      }
      const rows = (data ?? []) as unknown as DbSaleRow[];
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
    return out;
  }
  async function fetchAllRedemptions(): Promise<DbRedemptionRow[]> {
    const out: DbRedemptionRow[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .from('payments')
        .select('id, gift_card_code, amount_cents, captured_at, ticket_id, tickets(id, ticket_number, business_date, client_name)')
        .eq('method', 'gift')
        .range(offset, offset + PAGE - 1);
      if (error) {
        console.error('[giftCertificates] redemptions:', error.message);
        return out;
      }
      const rows = (data ?? []) as unknown as DbRedemptionRow[];
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
    return out;
  }
  const [sales, redemptions] = await Promise.all([fetchAllSales(), fetchAllRedemptions()]);

  // Index redemptions by normalized serial. Keep the earliest redemption
  // when more than one row claims the same serial (rare data-entry typo).
  const redemptionByNorm = new Map<string, DbRedemptionRow>();
  for (const r of redemptions) {
    const norm = normalizeSerial(r.gift_card_code);
    if (!norm) continue;
    const existing = redemptionByNorm.get(norm);
    if (!existing || new Date(r.captured_at) < new Date(existing.captured_at)) {
      redemptionByNorm.set(norm, r);
    }
  }

  const out: GiftCertificate[] = [];
  for (const s of sales) {
    const { display, norm } = serialFromLineName(s.name ?? '');
    const ticket = s.tickets;
    if (!ticket) continue; // orphaned sale line — skip
    if (ticket.status === 'voided') continue; // voided sale — not a real cert, serial is free
    const redemption = norm ? redemptionByNorm.get(norm) ?? null : null;
    out.push({
      serial: display,
      normalizedSerial: norm,
      purchaseDate: ticket.business_date,
      purchasedAtMs: new Date(ticket.opened_at).getTime(),
      purchaseTicketId: ticket.id,
      purchaseTicketNumber: ticket.ticket_number,
      purchaseClientName: ticket.client_name || 'Walk-in',
      valueCents: s.ext_price_cents,
      redeemedAtMs: redemption ? new Date(redemption.captured_at).getTime() : null,
      redeemedDate: redemption?.tickets?.business_date ?? null,
      redeemedTicketId: redemption?.tickets?.id ?? null,
      redeemedTicketNumber: redemption?.tickets?.ticket_number ?? null,
      redeemedClientName: redemption?.tickets?.client_name ?? null,
      redeemedAmountCents: redemption?.amount_cents ?? null,
    });
  }
  // Newest sales first
  out.sort((a, b) => b.purchasedAtMs - a.purchasedAtMs);
  return out;
}

// ── single-card balance lookup ──────────────────────────────────────────────
//
// Used by TicketModal to show the remaining balance in pink next to the gift
// card code field and hard-cap the redemption amount.
export interface GiftCardBalance {
  found: boolean;
  originalCents: number;
  usedCents: number;
  balanceCents: number;
  /** True when the lookup could NOT complete (DB/network error) — distinct
   *  from a genuine "not in the system" (found=false, lookupError falsy). The
   *  redemption guard blocks on BOTH but with different messaging. */
  lookupError?: boolean;
}

export async function lookupGiftCardBalance(
  rawSerial: string,
  excludeTicketId?: string | null,
): Promise<GiftCardBalance> {
  const norm = normalizeSerial(rawSerial);
  const empty: GiftCardBalance = { found: false, originalCents: 0, usedCents: 0, balanceCents: 0 };
  if (!norm) return empty;

  // Find the sale line. ticket_items.name contains "Gift Certificate #XXXXX".
  // Match by ILIKE with the trailing serial; normalize handles leading zeros.
  const padded = norm.padStart(5, '0');
  const { data: saleRows, error: saleErr } = await supabase
    .from('ticket_items')
    .select('id, name, ext_price_cents, tickets(status)')
    .eq('kind', 'gift_card_sale')
    .or(`name.ilike.%#${norm},name.ilike.%#${padded}`);
  if (saleErr) {
    console.warn('[giftCertificates] lookupGiftCardBalance sale fetch:', saleErr.message);
    return { ...empty, lookupError: true };
  }
  // Filter to the row whose serial actually matches (the ILIKE above may have
  // false positives on long-tailed similar serials, e.g. searching #42 also
  // matches #1042). Also exclude sales on a VOIDED ticket — a voided sale
  // frees its serial for reuse, so its value must not count toward a balance.
  const matchingSales = (saleRows ?? []).filter((r) => {
    const row = r as { name?: string; tickets?: { status?: string } | { status?: string }[] | null };
    const tk = Array.isArray(row.tickets) ? row.tickets[0] : row.tickets;
    if (tk?.status === 'voided') return false;
    const { norm: rNorm } = serialFromLineName(row.name ?? '');
    return rNorm === norm;
  });
  if (matchingSales.length === 0) return empty;
  // Sum all sale lines for this serial (normally exactly one, but be tolerant
  // if a legacy import duplicated it).
  const originalCents = matchingSales.reduce(
    (s, r) => s + Number((r as { ext_price_cents: number | string }).ext_price_cents || 0),
    0,
  );

  // Sum all prior redemption payments. ILIKE-match on gift_card_code with
  // normalized-serial fallback. Excludes the named ticket if provided.
  let q = supabase
    .from('payments')
    .select('amount_cents, gift_card_code, ticket_id')
    .eq('method', 'gift')
    .or(`gift_card_code.ilike.%${norm},gift_card_code.ilike.%${padded}`);
  if (excludeTicketId) {
    q = q.neq('ticket_id', excludeTicketId);
  }
  const { data: redemptionRows, error: redErr } = await q;
  if (redErr) {
    console.warn('[giftCertificates] lookupGiftCardBalance redemptions fetch:', redErr.message);
    // Couldn't load prior redemptions — don't optimistically report the full
    // value as available (that could green-light an over-redemption). Flag the
    // error so the guard blocks until the balance can actually be verified.
    return { found: true, originalCents, usedCents: 0, balanceCents: originalCents, lookupError: true };
  }
  const usedCents = (redemptionRows ?? [])
    .filter((r) => normalizeSerial((r as { gift_card_code: string | null }).gift_card_code) === norm)
    .reduce((s, r) => s + Number((r as { amount_cents: number | string }).amount_cents || 0), 0);

  const balanceCents = Math.max(0, originalCents - usedCents);
  return { found: true, originalCents, usedCents, balanceCents };
}

// ── full detail for the redemption dialog ────────────────────────────────────
//
// Like lookupGiftCardBalance but also returns the purchase date/buyer and the
// list of prior redemptions (date, amount, ticket #) so the redeem dialog can
// show the cashier the cert's full history before they apply an amount.
export interface GiftCardRedemption {
  date: string | null;          // YYYY-MM-DD business date
  amountCents: number;
  ticketNumber: number | null;
}
export interface GiftCardDetail {
  found: boolean;
  lookupError?: boolean;
  originalCents: number;
  purchaseDate: string | null;          // YYYY-MM-DD business date
  purchaseClientName: string | null;
  usedCents: number;
  balanceCents: number;
  redemptions: GiftCardRedemption[];
}

export async function lookupGiftCardDetail(
  rawSerial: string,
  excludeTicketId?: string | null,
): Promise<GiftCardDetail> {
  const norm = normalizeSerial(rawSerial);
  const empty: GiftCardDetail = {
    found: false, originalCents: 0, purchaseDate: null, purchaseClientName: null,
    usedCents: 0, balanceCents: 0, redemptions: [],
  };
  if (!norm) return empty;
  const padded = norm.padStart(5, '0');

  const { data: saleRows, error: saleErr } = await supabase
    .from('ticket_items')
    .select('id, name, ext_price_cents, tickets(status, business_date, client_name, opened_at)')
    .eq('kind', 'gift_card_sale')
    .or(`name.ilike.%#${norm},name.ilike.%#${padded}`);
  if (saleErr) {
    console.warn('[giftCertificates] lookupGiftCardDetail sale fetch:', saleErr.message);
    return { ...empty, lookupError: true };
  }
  type SaleTk = { status?: string; business_date?: string; client_name?: string; opened_at?: string };
  const matchingSales = (saleRows ?? []).filter((r) => {
    const row = r as { name?: string; tickets?: SaleTk | SaleTk[] | null };
    const tk = Array.isArray(row.tickets) ? row.tickets[0] : row.tickets;
    if (tk?.status === 'voided') return false;
    const { norm: rNorm } = serialFromLineName(row.name ?? '');
    return rNorm === norm;
  });
  if (matchingSales.length === 0) return empty;

  const originalCents = matchingSales.reduce(
    (s, r) => s + Number((r as { ext_price_cents: number | string }).ext_price_cents || 0), 0,
  );
  let purchaseDate: string | null = null;
  let purchaseClientName: string | null = null;
  let earliest = Infinity;
  for (const r of matchingSales) {
    const row = r as { tickets?: SaleTk | SaleTk[] | null };
    const tk = Array.isArray(row.tickets) ? row.tickets[0] : row.tickets;
    if (!tk) continue;
    const t = tk.opened_at ? new Date(tk.opened_at).getTime() : Infinity;
    if (t < earliest) { earliest = t; purchaseDate = tk.business_date ?? null; purchaseClientName = tk.client_name ?? null; }
  }

  let q = supabase
    .from('payments')
    .select('amount_cents, gift_card_code, ticket_id, captured_at, tickets(business_date, ticket_number)')
    .eq('method', 'gift')
    .or(`gift_card_code.ilike.%${norm},gift_card_code.ilike.%${padded}`);
  if (excludeTicketId) q = q.neq('ticket_id', excludeTicketId);
  const { data: redRows, error: redErr } = await q;
  if (redErr) {
    console.warn('[giftCertificates] lookupGiftCardDetail redemptions fetch:', redErr.message);
    return { found: true, originalCents, purchaseDate, purchaseClientName, usedCents: 0, balanceCents: originalCents, redemptions: [], lookupError: true };
  }
  type RedTk = { business_date?: string; ticket_number?: number };
  const redemptions: GiftCardRedemption[] = (redRows ?? [])
    .filter((r) => normalizeSerial((r as { gift_card_code: string | null }).gift_card_code) === norm)
    .map((r) => {
      const row = r as { amount_cents: number | string; tickets?: RedTk | RedTk[] | null };
      const tk = Array.isArray(row.tickets) ? row.tickets[0] : row.tickets;
      return { date: tk?.business_date ?? null, amountCents: Number(row.amount_cents || 0), ticketNumber: tk?.ticket_number ?? null };
    })
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  const usedCents = redemptions.reduce((s, r) => s + r.amountCents, 0);
  const balanceCents = Math.max(0, originalCents - usedCents);
  return { found: true, originalCents, purchaseDate, purchaseClientName, usedCents, balanceCents, redemptions };
}
