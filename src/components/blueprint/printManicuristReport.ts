// Print helper for the per-manicurist service report (Blueprint → Reports →
// Staff → Manicurists). Mirrors printReceipt.ts's pattern: opens a new
// window with self-contained HTML+CSS and triggers the system print dialog.
//
// Lines are grouped by business date with a subtotal per day, plus a grand
// total at the bottom.

import { formatMoney, formatLongDate } from './reportShared';

export interface ManicuristPrintLine {
  businessDate: string;
  ticketNumber: number;
  clientName: string;
  serviceName: string;
  extCents: number;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[c]!;
  });
}

export function printManicuristReport(params: {
  staffName: string;
  rangeLabel: string;
  lines: ManicuristPrintLine[];
  totalServices: number;
  totalCents: number;
}): void {
  const {
    staffName, rangeLabel, lines, totalServices, totalCents,
  } = params;

  // Lines arrive newest-first by date then ticket #; group consecutive
  // lines sharing a businessDate into day sections, each with a subtotal.
  const days: { businessDate: string; lines: ManicuristPrintLine[]; subtotalCents: number }[] = [];
  for (const line of lines) {
    let day = days[days.length - 1];
    if (!day || day.businessDate !== line.businessDate) {
      day = { businessDate: line.businessDate, lines: [], subtotalCents: 0 };
      days.push(day);
    }
    day.lines.push(line);
    day.subtotalCents += line.extCents;
  }

  const dayBlocks = days.map((day) => `
    <div class="day-header">${escapeHtml(formatLongDate(day.businessDate))}</div>
    <table>
      <thead>
        <tr><th>Ticket</th><th>Client</th><th>Service</th><th class="num">Price</th></tr>
      </thead>
      <tbody>
        ${day.lines.map((line) => `
        <tr>
          <td>#${line.ticketNumber}</td>
          <td>${escapeHtml(line.clientName)}</td>
          <td>${escapeHtml(line.serviceName)}</td>
          <td class="num">${formatMoney(line.extCents)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="day-total">Day total (${day.lines.length}) <span>${formatMoney(day.subtotalCents)}</span></div>
  `).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Manicurist Report — ${escapeHtml(staffName)}</title>
<style>
  @page { size: letter; margin: 0.6in; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Arial Narrow', Arial, Helvetica, sans-serif;
    font-size: 16px;
    color: #111;
    max-width: 7in;
    margin: 0 auto;
    padding: 1rem;
    line-height: 1.4;
  }
  h1 { font-size: 1.7rem; letter-spacing: 0.1em; margin: 0 0 0.15rem; }
  .subhead { color: #555; font-size: 1.05rem; margin-bottom: 1rem; }
  .summary { display: flex; gap: 1.5rem; margin-bottom: 1.25rem; font-size: 1.05rem; }
  .summary .label { color: #666; }
  .summary .value { font-weight: bold; }
  .day-header {
    font-weight: bold; letter-spacing: 0.05em; font-size: 1.1rem;
    margin: 1.25rem 0 0.4rem; padding-bottom: 0.2rem; border-bottom: 2px solid #111;
  }
  table { width: 100%; border-collapse: collapse; font-size: 1rem; }
  th { text-align: left; color: #666; font-weight: normal; font-size: 0.85rem; letter-spacing: 0.05em; padding: 0.25rem 0.4rem; border-bottom: 1px solid #ccc; }
  td { padding: 0.35rem 0.4rem; vertical-align: top; }
  tr:nth-child(even) td { background: #f7f7f7; }
  .num { text-align: right; white-space: nowrap; }
  th.num { text-align: right; }
  .day-total {
    display: flex; justify-content: space-between; font-weight: bold;
    font-size: 1.02rem; padding: 0.35rem 0.4rem; border-top: 1px dashed #999;
  }
  .grand-total {
    display: flex; justify-content: space-between; font-weight: bold;
    font-size: 1.3rem; margin-top: 1.5rem; padding-top: 0.6rem; border-top: 2px solid #111;
  }
  .print-btn {
    display: block;
    margin: 1.5rem auto 0;
    padding: 0.6rem 1.5rem;
    font-family: inherit;
    font-size: 1rem;
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
  <h1>${escapeHtml(staffName.toUpperCase())}</h1>
  <div class="subhead">${escapeHtml(rangeLabel)}</div>
  <div class="summary">
    <div><span class="label">Services:</span> <span class="value">${totalServices}</span></div>
    <div><span class="label">Total Sales:</span> <span class="value">${formatMoney(totalCents)}</span></div>
  </div>
  ${dayBlocks || '<p><em>No service lines in this range.</em></p>'}
  <div class="grand-total">TOTAL <span>${formatMoney(totalCents)}</span></div>
  <button class="print-btn no-print" onclick="window.print()">PRINT</button>
</body>
</html>`;

  const win = window.open('', '_blank', 'width=720,height=900');
  if (!win) {
    alert('Pop-up blocked — please allow pop-ups for this site so reports can print.');
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  setTimeout(() => { win.focus(); win.print(); }, 200);
}
