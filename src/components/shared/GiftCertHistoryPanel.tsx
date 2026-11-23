// GiftCertHistoryPanel — one gift certificate's history: how it was loaded
// (sold here, by whom, or carried over from SalonBiz), every use, and the
// balance. Shared by Blueprint → Gift Certificates and the register's
// one-card lookup (GiftCertLookupModal), so both always show the same thing.
//
// `large` is the register's front-desk size: the desk reads it from a step
// back, so text, rows and the balance are all bigger (Tony, 2026-11-23:
// "make the pop up after search bigger, i cant see").

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

const SIZES = {
  normal: {
    pad: 'px-4',
    title: 'font-bebas text-lg tracking-[2px]',
    summary: 'font-mono text-[11px] text-gray-500',
    balance: 'font-bold text-emerald-600',
    message: 'font-mono text-xs',
    grid: 'grid-cols-[120px_1fr_80px_1fr_110px]',
    head: 'py-2 font-mono text-[10px]',
    row: 'py-2.5',
    small: 'font-mono text-xs',
    big: 'font-mono text-sm',
    note: 'font-mono text-[11px]',
  },
  medium: {
    pad: 'px-5',
    title: 'font-bebas text-2xl tracking-[3px]',
    summary: 'font-mono text-base text-gray-600',
    balance: 'font-bold text-emerald-600 text-xl',
    message: 'font-mono text-base',
    grid: 'grid-cols-[140px_1.3fr_90px_1fr_120px]',
    head: 'py-2.5 font-mono text-xs',
    row: 'py-3',
    small: 'font-mono text-base',
    big: 'font-mono text-lg',
    note: 'font-mono text-sm',
  },
  large: {
    pad: 'px-6',
    title: 'font-bebas text-3xl tracking-[3px]',
    summary: 'font-mono text-lg text-gray-600',
    balance: 'font-bold text-emerald-600 text-2xl',
    message: 'font-mono text-lg',
    grid: 'grid-cols-[170px_1.4fr_100px_1fr_140px]',
    head: 'py-3 font-mono text-sm',
    row: 'py-4',
    small: 'font-mono text-lg',
    big: 'font-mono text-xl',
    note: 'font-mono text-base',
  },
} as const;

export default function CertHistoryPanel({
  serial, history, loading, nearMisses, onPick, size = 'normal',
}: {
  serial: string;
  history: GiftCertHistory | null;
  loading: boolean;
  nearMisses: string[];
  onPick: (serial: string) => void;
  /** normal = compact; medium = register popup; large = Blueprint. */
  size?: keyof typeof SIZES;
}) {
  const s = SIZES[size];

  const header = (
    <div className={`${s.pad} py-3 border-b border-gray-100 flex items-center gap-x-4 gap-y-1 flex-wrap`}>
      <h3 className={`${s.title} text-gray-800`}>HISTORY · #{serial}</h3>
      {history?.found && !loading && (
        <span className={s.summary}>
          Loaded {formatMoneyCents(history.loadedCents)} · Used {formatMoneyCents(history.usedCents)} ·{' '}
          <span className={s.balance}>Balance {formatMoneyCents(history.balanceCents)}</span>
        </span>
      )}
    </div>
  );

  let body: ReactNode;
  if (loading || !history) {
    body = <div className={`${s.pad} py-6 text-center ${s.message} text-gray-400`}>Looking up #{serial}…</div>;
  } else if (history.lookupError) {
    body = (
      <div className={`${s.pad} py-6 text-center ${s.message} text-rose-600`}>
        Couldn't load this certificate's history. Check the connection and try again.
      </div>
    );
  } else if (!history.found) {
    body = (
      <div className={`${s.pad} py-4 space-y-2 ${s.message} text-gray-700`}>
        <p>
          <span className="font-bold">No record of #{serial} in TurnEm.</span> It was never sold or used
          here, and it was not in the SalonBiz import on May 18, 2026 — that import only brought over
          certificates that still had a balance. Any history from before then is only in SalonBiz.
        </p>
        {nearMisses.length > 0 && (
          <p className="text-gray-500">
            Close numbers that do exist (one digit off, or two digits swapped):{' '}
            {nearMisses.map((n, i) => (
              <span key={n}>
                {i > 0 && ', '}
                <button
                  onClick={() => onPick(n)}
                  className="font-bold text-pink-600 hover:underline"
                >
                  #{n}
                </button>
              </span>
            ))}
          </p>
        )}
      </div>
    );
  } else {
    type Ev = { key: string; date: string | null; sort: string; what: ReactNode; ticket: string; client: string; amount: ReactNode; voided: boolean; salonBiz: boolean };
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
        salonBiz: l.importedFromSalonBiz,
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
        salonBiz: false,
      })),
    ].sort((a, b) => a.sort.localeCompare(b.sort));

    const importedOnly = history.loads.length > 0 && history.loads.every((l) => l.importedFromSalonBiz);
    body = (
      <div>
        <div className={`grid ${s.grid} gap-3 ${s.pad} ${s.head} bg-gray-50 border-b border-gray-100 tracking-wider font-semibold text-gray-400 uppercase`}>
          <span>Date</span>
          <span>What</span>
          <span>Ticket</span>
          <span>Client</span>
          <span className="text-right">Amount</span>
        </div>
        {events.map((e) => (
          <div
            key={e.key}
            className={`grid ${s.grid} gap-3 ${s.pad} ${s.row} border-b border-gray-50 last:border-b-0 items-center ${e.voided ? 'opacity-50 line-through' : ''}`}
            title={e.voided ? 'On a voided ticket — not counted' : undefined}
          >
            <span className={`${s.small} text-gray-700`}>{e.salonBiz ? 'SalonBiz' : formatDate(e.date)}</span>
            <span className={`${s.small} text-gray-800`}>{e.what}</span>
            <span className={`${s.small} text-gray-700`}>{e.ticket}</span>
            <span className={`${s.big} text-gray-800 truncate`}>{e.client}</span>
            <span className={`${s.big} font-bold text-right`}>{e.amount}</span>
          </div>
        ))}
        {history.loads.length === 0 && (
          <div className={`${s.pad} py-2 ${s.note} text-amber-700 bg-amber-50`}>
            Used in TurnEm, but no sale or SalonBiz import was found for this number.
          </div>
        )}
        {importedOnly && (
          <div className={`${s.pad} py-2 ${s.note} text-gray-500 bg-gray-50`}>
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
