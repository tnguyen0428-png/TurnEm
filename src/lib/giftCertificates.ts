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
  const s = (raw ?? '').trim().replace(/^#/, '').replace(/^0+/, '');
  return s;
}

/** Extract the serial number from a gift_card_sale line item name. */
function serialFromLineName(name: string): { display: string; norm: string } {
  // Match the first "#<digits>" run, fall back to the first run of digits.
  const m = name.match(/#(\d+)/) ?? name.match(/(\d+)/);
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
  const [salesRes, redemptionsRes] = await Promise.all([
    supabase
      .from('ticket_items')
      .select('id, name, ext_price_cents, ticket_id, tickets(id, ticket_number, business_date, client_name, opened_at)')
      .eq('kind', 'gift_card_sale'),
    supabase
      .from('payments')
      .select('id, gift_card_code, amount_cents, captured_at, ticket_id, tickets(id, ticket_number, business_date, client_name)')
      .eq('method', 'gift'),
  ]);
  if (salesRes.error) {
    console.error('[giftCertificates] sales:', salesRes.error.message);
    return [];
  }
  if (redemptionsRes.error) {
    console.error('[giftCertificates] redemptions:', redemptionsRes.error.message);
  }

  // Index redemptions by normalized serial. Keep the earliest redemption
  // when more than one row claims the same serial (rare data-entry typo).
  const redemptionByNorm = new Map<string, DbRedemptionRow>();
  for (const r of (redemptionsRes.data ?? []) as unknown as DbRedemptionRow[]) {
    const norm = normalizeSerial(r.gift_card_code);
    if (!norm) continue;
    const existing = redemptionByNorm.get(norm);
    if (!existing || new Date(r.captured_at) < new Date(existing.captured_at)) {
      redemptionByNorm.set(norm, r);
    }
  }

  const out: GiftCertificate[] = [];
  for (const s of (salesRes.data ?? []) as unknown as DbSaleRow[]) {
    const { display, norm } = serialFromLineName(s.name ?? '');
    const ticket = s.tickets;
    if (!ticket) continue; // orphaned sale line — skip
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
