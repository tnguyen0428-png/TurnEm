// GiftCertificatesReport — Blueprint → Reports → Gift Certificates
//
// Two flat lists pulled from a single fetchGiftCertificates() call:
//   OPEN  — sold but never redeemed
//   USED  — sold AND redeemed at least once
//
// Single search box filters both lists. Match is by:
//   - serial (substring of the printed serial, case-insensitive after norm)
//   - purchase date (substring of YYYY-MM-DD)
//   - customer name (purchaser or redeemer)
// Empty query shows everything.
//
// Typing a full certificate number (4+ digits, or TM + digits) also opens a
// HISTORY panel for that one card: how it was loaded (sold here, or imported
// from SalonBiz on 5/18), every use, and the balance. When the number isn't
// in TurnEm at all it says so plainly and lists one-digit-off / swapped
// numbers that are (Tony, 2026-11-23: card 1606822889).

import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import {
  fetchGiftCertificates,
  fetchGiftCertHistory,
  nearMissSerials,
  normalizeSerial,
  type GiftCertificate,
  type GiftCertHistory,
} from '../../lib/giftCertificates';
import { formatMoneyCents } from '../../lib/tickets';
import { ReportRangeHeader, useReportRange } from './reportShared';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00');
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  }).format(d);
}

export default function GiftCertificatesReport() {
  const [range, setRange] = useReportRange();
  const [certs, setCerts] = useState<GiftCertificate[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const rows = await fetchGiftCertificates();
      if (!cancelled) {
        setCerts(rows);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Query filter only — text search across serial / dates / customers. Range
  // filter is applied separately to open and used lists because each list
  // cares about a different date (purchase vs redemption).
  const queryFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return certs;
    const qNorm = normalizeSerial(q);
    return certs.filter((c) => {
      if (c.serial.toLowerCase().includes(q)) return true;
      if (qNorm && c.normalizedSerial.includes(qNorm)) return true;
      if (c.purchaseDate.includes(q)) return true;
      if ((c.redeemedDate ?? '').includes(q)) return true;
      if ((c.purchaseClientName || '').toLowerCase().includes(q)) return true;
      if ((c.redeemedClientName || '').toLowerCase().includes(q)) return true;
      return false;
    });
  }, [certs, query]);

  // OPEN list: certs sold in the date range that haven't been redeemed yet.
  const open = useMemo(
    () => queryFiltered.filter(
      (c) => c.redeemedAtMs == null
        && c.purchaseDate >= range.from
        && c.purchaseDate <= range.to,
    ),
    [queryFiltered, range.from, range.to],
  );

  // USED list: certs redeemed in the date range, regardless of when sold.
  const used = useMemo(
    () => queryFiltered.filter(
      (c) => c.redeemedDate != null
        && c.redeemedDate >= range.from
        && c.redeemedDate <= range.to,
    ),
    [queryFiltered, range.from, range.to],
  );

  const summary = useMemo(() => {
    const openValue = open.reduce((s, c) => s + c.valueCents, 0);
    const usedValue = used.reduce((s, c) => s + (c.redeemedAmountCents ?? c.valueCents), 0);
    return { openValue, usedValue, openCount: open.length, usedCount: used.length };
  }, [open, used]);

  // One-card history: only once the search looks like a whole serial.
  const historySerial = useMemo(() => {
    const q = query.trim().replace(/\s+/g, '');
    return /^#?(TM)?\d{4,}$/i.test(q) ? normalizeSerial(q) : '';
  }, [query]);
  const [history, setHistory] = useState<GiftCertHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  useEffect(() => {
    if (!historySerial) {
      setHistory(null);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    const t = setTimeout(async () => {
      const h = await fetchGiftCertHistory(historySerial);
      if (!cancelled) {
        setHistory(h);
        setHistoryLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [historySerial]);
  const nearMisses = useMemo(
    () => (history && !history.found
      ? nearMissSerials(history.serial, certs.map((c) => c.normalizedSerial))
      : []),
    [history, certs],
  );

  return (
    <div className="p-6 overflow-y-auto h-full space-y-5">
      <ReportRangeHeader title="GIFT CERTIFICATES" range={range} onRangeChange={setRange} />
      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-2 min-w-[280px]">
          <Search size={14} className="text-gray-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search serial or customer — full serial shows its history"
            className="flex-1 font-mono text-xs bg-transparent focus:outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="font-mono text-[10px] text-gray-400 hover:text-gray-700 uppercase tracking-wider"
            >
              clear
            </button>
          )}
        </label>
        <span className="font-mono text-[10px] text-gray-400 tracking-wider">
          OPEN filtered by purchase date · USED filtered by redemption date
        </span>
      </div>

      {historySerial && (
        <CertHistoryPanel
          serial={historySerial}
          history={history}
          loading={historyLoading}
          nearMisses={nearMisses}
          onPick={(s) => setQuery(s)}
        />
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi label="Open Certificates" value={summary.openCount.toString()} loading={loading} />
        <Kpi label="Open Value" value={formatMoneyCents(summary.openValue)} accent="emerald" loading={loading} />
        <Kpi label="Used Certificates" value={summary.usedCount.toString()} loading={loading} />
        <Kpi label="Used Value" value={formatMoneyCents(summary.usedValue)} loading={loading} />
      </div>

      <CertList
        title="OPEN"
        subtitle={`${open.length} unused · ${formatMoneyCents(summary.openValue)} outstanding`}
        certs={open}
        kind="open"
        emptyText={loading ? 'Loading…' : query ? 'No open certificates match the search.' : 'No open gift certificates.'}
      />

      <CertList
        title="USED"
        subtitle={`${used.length} redeemed · ${formatMoneyCents(summary.usedValue)} value`}
        certs={used}
        kind="used"
        emptyText={loading ? 'Loading…' : query ? 'No used certificates match the search.' : 'No used gift certificates yet.'}
      />
    </div>
  );
}

function CertList({
  title, subtitle, certs, kind, emptyText,
}: {
  title: string;
  subtitle: string;
  certs: GiftCertificate[];
  kind: 'open' | 'used';
  emptyText: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3">
        <h3 className="font-bebas text-lg tracking-[2px] text-gray-800">{title}</h3>
        <span className="font-mono text-[10px] text-gray-400">{subtitle}</span>
      </div>
      {certs.length === 0 ? (
        <div className="px-4 py-6 text-center font-mono text-xs text-gray-400">{emptyText}</div>
      ) : (
        <div>
          <div className="grid grid-cols-[110px_120px_1fr_110px_120px_1fr_110px] gap-2 px-4 py-2 bg-gray-50 border-b border-gray-100 font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">
            <span>Serial</span>
            <span>Purchased</span>
            <span>Purchaser</span>
            <span className="text-right">Value</span>
            <span>Redeemed</span>
            <span>Redeemer</span>
            <span className="text-right">Used</span>
          </div>
          {certs.map((c, idx) => (
            <div
              key={`${c.purchaseTicketId}:${c.normalizedSerial || c.serial}`}
              className={`grid grid-cols-[110px_120px_1fr_110px_120px_1fr_110px] gap-2 px-4 py-2.5 border-b border-gray-50 last:border-b-0 items-center transition-colors hover:bg-pink-100 ${
                idx % 2 === 1 ? 'bg-gray-50' : ''
              }`}
            >
              <span className="font-mono text-sm font-bold text-gray-800">#{c.serial || '—'}</span>
              <span className="font-mono text-xs text-gray-700">{formatDate(c.purchaseDate)}</span>
              <span className="font-mono text-sm text-gray-800 truncate" title={c.purchaseClientName}>
                {c.purchaseClientName}
              </span>
              <span className="font-mono text-sm font-bold text-gray-900 text-right">{formatMoneyCents(c.valueCents)}</span>
              <span className="font-mono text-xs text-gray-700">
                {kind === 'open' ? '—' : formatDate(c.redeemedDate)}
              </span>
              <span className="font-mono text-sm text-gray-800 truncate" title={c.redeemedClientName ?? ''}>
                {kind === 'open' ? '—' : (c.redeemedClientName || '—')}
              </span>
              <span className="font-mono text-sm text-gray-700 text-right">
                {kind === 'open'
                  ? '—'
                  : formatMoneyCents(c.redeemedAmountCents ?? 0)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CertHistoryPanel({
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

  let body: React.ReactNode;
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
    type Ev = { key: string; date: string | null; sort: string; what: React.ReactNode; ticket: string; client: string; amount: React.ReactNode; voided: boolean };
    const events: Ev[] = [
      ...history.loads.map((l, i) => ({
        key: `load-${i}`,
        date: l.date,
        sort: `${l.date ?? ''}-0`,
        what: l.importedFromSalonBiz
          ? <span>Imported from SalonBiz <span className="text-gray-400">(balance at the time)</span></span>
          : 'Sold',
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
            <span className="font-mono text-xs text-gray-700">{formatDate(e.date)}</span>
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

function Kpi({
  label, value, accent, loading,
}: {
  label: string; value: string; accent?: 'emerald'; loading?: boolean;
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 px-4 py-4">
      <div className="font-mono text-[10px] font-bold text-gray-400 tracking-wider uppercase">{label}</div>
      <div className={`font-mono text-2xl font-bold mt-1 ${accent === 'emerald' ? 'text-emerald-600' : 'text-gray-900'}`}>
        {loading ? '…' : value}
      </div>
    </div>
  );
}
