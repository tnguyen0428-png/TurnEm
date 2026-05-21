// Print-receipt helper.
//
// Opens a new browser window containing a print-formatted receipt for the
// given closed ticket and triggers the system print dialog. Letter/A4 page
// (cashier picks paper in the print dialog). The receipt is self-contained
// HTML+CSS — no React, no shared CSS dependencies — so it survives the
// new-window navigation cleanly.
//
// Wired in from RegisterScreen's TicketList (printer icon on each closed
// ticket row). Voided and open tickets don't get the button — open tickets
// aren't paid yet, voided ones shouldn't be re-issued as customer receipts.

import { formatMoneyCents } from '../../lib/tickets';
import type { Ticket } from '../../types';

// Customer-facing salon branding (the AQUA nails bar logo lives in
// public/AQUA_logo_FINAL.jpg and is served from the site root in
// production). The TurnEm internal logo isn't used on receipts.
const SALON_NAME = 'AQUA';
const SALON_LINE_2 = 'nails bar';
const LOGO_URL = '/AQUA_logo_FINAL.jpg';
const THANK_YOU = 'THANK YOU — PLEASE COME AGAIN!';
const FOOTER = 'www.aquanailsbar.com';

function methodLabel(m: string): string {
  if (m === 'cash') return 'Cash';
  if (m === 'visa_mc') return 'Visa / MC';
  if (m === 'gift') return 'Gift';
  return m;
}

function formatDateTime(ms: number): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(ms));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[c]!;
  });
}

export function printReceipt(ticket: Ticket): void {
  const closedTs = ticket.closedAt ?? ticket.openedAt;

  // Items, skipping pure-discount lines (those are folded into the
  // discount total below so we don't double-count or show negative rows
  // mid-list).
  const itemRows = [...ticket.items]
    .filter((it) => it.kind !== 'discount')
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((it) => {
      const qty = it.quantity > 1 ? ` × ${it.quantity}` : '';
      const staffStr = it.staff1Name
        ? `<div class="staff">${escapeHtml(it.staff1Name)}${it.staff2Name ? ' + ' + escapeHtml(it.staff2Name) : ''}</div>`
        : '';
      const discStr = it.discountCents > 0
        ? `<div class="staff">Line discount: -${formatMoneyCents(it.discountCents)}</div>`
        : '';
      return `
        <tr>
          <td class="item-name">${escapeHtml(it.name)}${qty}${staffStr}${discStr}</td>
          <td class="item-price">${formatMoneyCents(it.extPriceCents)}</td>
        </tr>`;
    })
    .join('');

  const lineDiscountTotal = ticket.items
    .filter((it) => it.kind === 'discount')
    .reduce((s, it) => s + Math.abs(it.extPriceCents), 0)
    + ticket.items.reduce((s, it) => s + (it.discountCents || 0), 0);
  const totalDiscount = (ticket.discountCents || 0) + lineDiscountTotal;

  const paymentRows = ticket.payments
    .map((p) => {
      const cashDetail = p.method === 'cash' && p.tenderedCents != null
        ? `<div class="staff">Tendered ${formatMoneyCents(p.tenderedCents)} · Change ${formatMoneyCents(p.changeCents || 0)}</div>`
        : '';
      return `
        <tr>
          <td>${methodLabel(p.method)}${cashDetail}</td>
          <td class="item-price">${formatMoneyCents(p.amountCents)}</td>
        </tr>`;
    })
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Receipt #${ticket.ticketNumber} — ${escapeHtml(ticket.clientName || 'Walk-in')}</title>
<style>
  @page { size: letter; margin: 0.5in; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Courier New', Courier, monospace;
    color: #111;
    max-width: 4.5in;
    margin: 0 auto;
    padding: 1rem;
    line-height: 1.4;
  }
  /* Logo image carries the brand. Text salon name/subline only show as
     a fallback when the image fails to load (controlled by the
     .show-fallback class added in the img onerror handler). */
  .logo { text-align: center; margin: 0.25rem 0 0.75rem; }
  .logo img { max-height: 110px; max-width: 90%; display: inline-block; }
  .salon, .salon-sub { display: none; text-align: center; }
  .show-fallback .salon { display: block; font-size: 1.4rem; font-weight: bold; letter-spacing: 0.2em; color: #2dd4cc; }
  .show-fallback .salon-sub { display: block; font-size: 1rem; color: #555; margin-bottom: 0.75rem; letter-spacing: 0.05em; }
  .meta { font-size: 0.9rem; margin: 0.75rem 0; }
  .meta div { margin: 0.2rem 0; }
  .label { color: #666; }
  table { width: 100%; border-collapse: collapse; margin: 0.5rem 0; }
  td { padding: 0.3rem 0; vertical-align: top; }
  .item-name { padding-right: 0.5rem; }
  .item-price { text-align: right; white-space: nowrap; min-width: 5rem; }
  .staff { font-size: 0.8rem; color: #666; margin-top: 0.15rem; padding-left: 0.5rem; }
  .divider { border-top: 1px dashed #999; margin: 0.5rem 0; }
  .double-divider { border-top: 2px solid #111; margin: 0.75rem 0 0.25rem; }
  .totals td { padding: 0.2rem 0; font-size: 0.95rem; }
  .totals .grand td { font-size: 1.15rem; font-weight: bold; padding-top: 0.4rem; }
  .pay-label { font-size: 0.85rem; color: #666; letter-spacing: 0.15em; margin: 0.75rem 0 0.25rem; }
  .thanks { text-align: center; margin-top: 1.5rem; font-weight: bold; letter-spacing: 0.15em; font-size: 1rem; }
  .footer { text-align: center; font-size: 0.8rem; color: #777; margin-top: 0.5rem; }
  .print-btn {
    display: block;
    margin: 1.5rem auto 0;
    padding: 0.6rem 1.5rem;
    font-family: inherit;
    font-size: 0.9rem;
    font-weight: bold;
    letter-spacing: 0.15em;
    cursor: pointer;
    background: #db2777;
    color: white;
    border: none;
    border-radius: 0.375rem;
  }
  .print-btn:hover { background: #be185d; }
  @media print {
    body { padding: 0; }
    .no-print { display: none !important; }
  }
</style>
</head>
<body>
  <div class="logo"><img src="${LOGO_URL}" alt="${SALON_NAME}" onerror="this.style.display='none'; document.body.classList.add('show-fallback');" /></div>
  <div class="salon">${SALON_NAME}</div>
  <div class="salon-sub">${SALON_LINE_2}</div>
  <div class="meta">
    <div><span class="label">Ticket:</span> <strong>#${ticket.ticketNumber}</strong></div>
    <div><span class="label">Date:</span> ${formatDateTime(closedTs)}</div>
    <div><span class="label">Client:</span> ${escapeHtml(ticket.clientName || 'Walk-in')}</div>
    ${ticket.primaryManicuristName ? `<div><span class="label">Primary Staff:</span> ${escapeHtml(ticket.primaryManicuristName)}</div>` : ''}
  </div>
  <div class="divider"></div>
  <table>
    ${itemRows || '<tr><td colspan="2"><em>No items</em></td></tr>'}
  </table>
  <div class="divider"></div>
  <table class="totals">
    <tr><td>Subtotal</td><td class="item-price">${formatMoneyCents(ticket.subtotalCents)}</td></tr>
    ${totalDiscount > 0 ? `<tr><td>Discount</td><td class="item-price">-${formatMoneyCents(totalDiscount)}</td></tr>` : ''}
    ${ticket.taxCents > 0 ? `<tr><td>Tax</td><td class="item-price">${formatMoneyCents(ticket.taxCents)}</td></tr>` : ''}
    ${ticket.tipCents > 0 ? `<tr><td>Tip</td><td class="item-price">${formatMoneyCents(ticket.tipCents)}</td></tr>` : ''}
    <tr class="grand"><td>TOTAL</td><td class="item-price">${formatMoneyCents(ticket.totalCents)}</td></tr>
  </table>
  <div class="double-divider"></div>
  <div class="pay-label">PAYMENT</div>
  <table>
    ${paymentRows || '<tr><td colspan="2"><em>No payment recorded</em></td></tr>'}
  </table>
  <div class="thanks">${THANK_YOU}</div>
  <div class="footer">${FOOTER}</div>
  <button class="print-btn no-print" onclick="window.print()">PRINT</button>
</body>
</html>`;

  const win = window.open('', '_blank', 'width=520,height=820');
  if (!win) {
    alert('Pop-up blocked — please allow pop-ups for this site so receipts can print.');
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  // Wait for the logo image to load (or fail) before firing the print
  // dialog so it's included in the printed output. Fall back to a 600ms
  // safety timer in case the load event never fires.
  let printed = false;
  const doPrint = () => {
    if (printed) return;
    printed = true;
    win.focus();
    win.print();
  };
  win.addEventListener('load', () => setTimeout(doPrint, 100));
  setTimeout(doPrint, 600);
}
