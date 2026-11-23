// GiftCertHistoryPanel — one gift certificate's history: how it was loaded
// (sold here, by whom, or carried over from SalonBiz), every use, and the
// balance. Shared by Blueprint → Gift Certificates and the register's
// one-card lookup (GiftCertLookupModal), so both always show the same thing.

import type { ReactNode } from 'react';
import type { GiftCertHistory } from '../../lib/giftCertificates';
import { formatMoneyCents } from '../../lib/tickets';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00');
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  }).format(d);
}

export default function CertHistoryPanel({
  serial, history, loading, nearMisses, onPick,
}: {
  serial: string;
  history: GiftCertHistory | null;
  loading: boolean;
  nearMisses: string[];
  onPick: (serial: string) => void;
}) {
  const header = (
    <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3 flex-wrap">
      <h3 className="font-bebas text-lg tracking-[2px] text-gray-800">HISTORY · #{serial}</h3>
      {history?.found && !loading && (
        <span className="font-mono text-[11px] text-gray-500">
          Loaded {formatMoneyCents(history.loadedCents)} · Used {formatMoneyCents(history.usedCents)} ·{' '}
          <span className="font-bold text-emerald-600">Balance {formatMoneyCents(history.balanceCents)}</span>
        </span>
      )}
    </div>
  );

  let body: ReactNode;
  if (loading || !history) {
    body = <div className="px-4 py-6 text-center font-mono text-xs text-gray-400">Looking up #{serial}…</div>;
  } else if (history.lookupError) {
    body = (
      <div className="px-4 py-6 text-center font-mono text-xs text-rose-600">
        Couldn't load this certificate's history. Check the connection and try again.
      </div>
    );
  } else if (!history.found) {
    body = (
      <div className="px-4 py-4 space-y-2 font-mono text-xs text-gray-700">
        <p>
          <span className="font-bold">No record of #{serial} in TurnEm.</span> It was never sold or used
          here, and it was not in the SalonBiz import on May 18, 2026 — that import only brought over
          certificates that still had a balance. Any history from before then is only in SalonBiz.
        </p>
        {nearMisses.length > 0 && (
          <p className="text-gray-500">
            Close numbers that do exist (one digit off, or two digits swapped):{' '}
            {nearMisses.map((s, i) => (
              <span key={s}>
                {i > 0 && ', '}
                <button
                  onClick={() => onPick(s)}
                  className="font-bold text-pink-600 hover:underline"
                >
                  #{s}
                </button>
              </span>
            ))}
          </p>
        )}
      </div>
    );
  } else {
    type Ev = { key: string; date: string | null; sort: string; what: ReactNode; ticket: string; client: string; amount: ReactNode; voided: boolean };
    const events: Ev[] = [
      ...history.loads.map((l, i) => ({
        key: `load-${i}`,
        // A SalonBiz card's 5/18 date is the import, not a purchase — show
        // "SalonBiz" there instead of a date (Tony, 2026-11-23).
        date: l.importedFromSalonBiz ? null : l.date,
        sort: `${l.date ?? ''}-0`,
        what: l.importedFromSalonBiz
          ? 'SalonBiz card — balance carried over'
          : <span>Sold{l.soldByName && <> by <span className="font-bold">{l.soldByName}</span></>}</span>,
        ticket: l.importedFromSalonBiz ? '—' : (l.ticketNumber != null ? `#${l.ticketNumber}` : '—'),
        client: l.importedFromSalonBiz ? '—' : (l.clientName || 'Walk-in'),
        amount: <span className="text-emerald-600">+{formatMoneyCents(l.amountCents)}</span>,
        voided: l.ticketStatus === 'voided',
      })),
      ...history.uses.map((u, i) => ({
        key: `use-${i}`,
        date: u.date,
        sort: `${u.date ?? ''}-1-${String(u.capturedAtMs ?? 0).padStart(15, '0')}`,
        what: u.isRefund ? 'Refunded to card' : 'Used',
        ticket: u.ticketNumber != null ? `#${u.ticketNumber}` : '—',
        client: u.clientName || 'Walk-in',
        amount: <span className="text-gray-900">−{formatMoneyCents(u.amountCents)}</span>,
        voided: u.ticketStatus === 'voided',
      })),
    ].sort((a, b) => a.sort.localeCompare(b.sort));

    const importedOnly = history.loads.length > 0 && history.loads.every((l) => l.importedFromSalonBiz);
    body = (
      <div>
        <div className="grid grid-cols-[120px_1fr_80px_1fr_110px] gap-2 px-4 py-2 bg-gray-50 border-b border-gray-100 font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">
          <span>Date</span>
          <span>What</span>
          <span>Ticket</span>
          <span>Client</span>
          <span className="text-right">Amount</span>
        </div>
        {events.map((e) => (
          <div
            key={e.key}
            className={`grid grid-cols-[120px_1fr_80px_1fr_110px] gap-2 px-4 py-2.5 border-b border-gray-50 last:border-b-0 items-center ${e.voided ? 'opacity-50 line-through' : ''}`}
            title={e.voided ? 'On a voided ticket — not counted' : undefined}
          >
            <span className="font-mono text-xs text-gray-700">{e.date === null && e.key.startsWith('load') ? 'SalonBiz' : formatDate(e.date)}</span>
            <span className="font-mono text-xs text-gray-800">{e.what}</span>
            <span className="font-mono text-xs text-gray-700">{e.ticket}</span>
            <span className="font-mono text-sm text-gray-800 truncate">{e.client}</span>
            <span className="font-mono text-sm font-bold text-right">{e.amount}</span>
          </div>
        ))}
        {history.loads.length === 0 && (
          <div className="px-4 py-2 font-mono text-[11px] text-amber-700 bg-amber-50">
            Used in TurnEm, but no sale or SalonBiz import was found for this number.
          </div>
        )}
        {importedOnly && (
          <div className="px-4 py-2 font-mono text-[11px] text-gray-500 bg-gray-50">
            Bought before TurnEm. Its original purchase and any uses before May 18, 2026 are only in SalonBiz.
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border-2 border-pink-200 overflow-hidden">
      {header}
      {body}
    </div>
  );
}
