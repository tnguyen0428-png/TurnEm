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
import CertHistoryPanel from '../shared/GiftCertHistoryPanel';
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
      if ((c.soldByName || '').toLowerCase().includes(q)) return true;
      return false;
    });
  }, [certs, query]);

  // A search looks across ALL dates — you're looking for a card, not a
  // period. The date range only applies while the search box is empty.
  const searching = query.trim().length > 0;

  // OPEN list: certs sold in the date range that haven't been redeemed yet.
  const open = useMemo(
    () => queryFiltered.filter(
      (c) => c.redeemedAtMs == null
        && (searching || (c.purchaseDate >= range.from && c.purchaseDate <= range.to)),
    ),
    [queryFiltered, range.from, range.to, searching],
  );

  // Amount of a cert used INSIDE the range (all of it while searching). A card
  // used $40 in August and $10 in September counts $10 for September — it
  // used to be missed entirely there, because only its first use was dated.
  const usedInRangeCents = useMemo(() => {
    const m = new Map<GiftCertificate, number>();
    for (const c of queryFiltered) {
      const cents = c.uses
        .filter((u) => searching || (u.date != null && u.date >= range.from && u.date <= range.to))
        .reduce((s, u) => s + u.cents, 0);
      if (cents > 0 || (searching && c.uses.length > 0)) m.set(c, cents);
    }
    return m;
  }, [queryFiltered, range.from, range.to, searching]);

  // USED list: certs used at least once in the date range, whenever sold.
  const used = useMemo(
    () => queryFiltered.filter((c) => usedInRangeCents.has(c)),
    [queryFiltered, usedInRangeCents],
  );

  // Totals, split SalonBiz (imported 5/18) vs sold in TurnEm.
  const summary = useMemo(() => {
    const split = <T,>(list: T[], isSb: (x: T) => boolean, val: (x: T) => number) => {
      const out = { sbCount: 0, sbValue: 0, tmCount: 0, tmValue: 0 };
      for (const x of list) {
        if (isSb(x)) { out.sbCount += 1; out.sbValue += val(x); }
        else { out.tmCount += 1; out.tmValue += val(x); }
      }
      return out;
    };
    const o = split(open, (c) => c.importedFromSalonBiz, (c) => c.valueCents);
    const u = split(used, (c) => c.importedFromSalonBiz, (c) => usedInRangeCents.get(c) ?? 0);
    return {
      open: o,
      used: u,
      openCount: o.sbCount + o.tmCount,
      openValue: o.sbValue + o.tmValue,
      usedCount: u.sbCount + u.tmCount,
      usedValue: u.sbValue + u.tmValue,
    };
  }, [open, used, usedInRangeCents]);

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
        <label className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-4 py-3 min-w-[460px]">
          <Search size={20} className="text-gray-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search serial, customer or who sold it — full serial shows its history"
            className="flex-1 font-mono text-base bg-transparent focus:outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="font-mono text-sm text-gray-400 hover:text-gray-700 uppercase tracking-wider"
            >
              clear
            </button>
          )}
        </label>
        <span className="font-mono text-sm text-gray-400 tracking-wider">
          {searching
            ? 'Searching ALL dates — the date range is ignored while searching'
            : 'OPEN filtered by purchase date · USED filtered by redemption date'}
        </span>
      </div>

      {historySerial && (
        <CertHistoryPanel
          serial={historySerial}
          history={history}
          loading={historyLoading}
          nearMisses={nearMisses}
          onPick={(s) => setQuery(s)}
          large
        />
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi
          label="Open Certificates" loading={loading}
          value={summary.openCount.toString()}
          sb={summary.open.sbCount.toString()} tm={summary.open.tmCount.toString()}
        />
        <Kpi
          label="Open Value" accent="emerald" loading={loading}
          value={formatMoneyCents(summary.openValue)}
          sb={formatMoneyCents(summary.open.sbValue)} tm={formatMoneyCents(summary.open.tmValue)}
        />
        <Kpi
          label="Used Certificates" loading={loading}
          value={summary.usedCount.toString()}
          sb={summary.used.sbCount.toString()} tm={summary.used.tmCount.toString()}
        />
        <Kpi
          label="Used Value" loading={loading}
          value={formatMoneyCents(summary.usedValue)}
          sb={formatMoneyCents(summary.used.sbValue)} tm={formatMoneyCents(summary.used.tmValue)}
        />
      </div>

      <CertList
        title="OPEN"
        subtitle={`${open.length} unused · ${formatMoneyCents(summary.openValue)} outstanding`}
        certs={open}
        kind="open"
        emptyText={loading ? 'Loading…' : query ? 'No open certificates match the search.' : 'No open gift certificates.'}
        onPick={setQuery}
      />

      <CertList
        title="USED"
        subtitle={`${used.length} redeemed · ${formatMoneyCents(summary.usedValue)} value`}
        certs={used}
        kind="used"
        emptyText={loading ? 'Loading…' : query ? 'No used certificates match the search.' : 'No used gift certificates yet.'}
        onPick={setQuery}
      />
    </div>
  );
}

function CertList({
  title, subtitle, certs, kind, emptyText, onPick,
}: {
  title: string;
  subtitle: string;
  certs: GiftCertificate[];
  kind: 'open' | 'used';
  emptyText: string;
  /** Clicking a row opens that card's history. */
  onPick: (serial: string) => void;
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3">
        <h3 className="font-bebas text-3xl tracking-[3px] text-gray-800">{title}</h3>
        <span className="font-mono text-sm text-gray-400">{subtitle}</span>
      </div>
      {certs.length === 0 ? (
        <div className="px-5 py-8 text-center font-mono text-base text-gray-400">{emptyText}</div>
      ) : (
        // On a narrow screen the 8 columns don't fit; scroll sideways rather
        // than squeezing "Bought by" to nothing and clipping Amount, Balance
        // and Redeemed off the right edge.
        <div className="overflow-x-auto">
         <div className="min-w-[1280px]">
          <div className="grid grid-cols-[160px_150px_130px_1fr_130px_130px_200px_1fr] gap-3 px-5 py-3 bg-gray-50 border-b border-gray-100 font-mono text-sm tracking-wider font-semibold text-gray-400 uppercase">
            <span>Serial</span>
            <span>Sold</span>
            <span>Sold by</span>
            <span>Bought by</span>
            <span className="text-right">Amount</span>
            <span className="text-right">Balance</span>
            <span>Redeemed</span>
            <span>Redeemed by</span>
          </div>
          {certs.map((c, idx) => (
            <button
              type="button"
              key={`${c.purchaseTicketId}:${c.normalizedSerial || c.serial}`}
              onClick={() => onPick(c.serial)}
              title="Show this certificate's history"
              className={`w-full text-left grid grid-cols-[160px_150px_130px_1fr_130px_130px_200px_1fr] gap-3 px-5 py-4 border-b border-gray-50 last:border-b-0 items-center transition-colors hover:bg-pink-100 ${
                idx % 2 === 1 ? 'bg-gray-50' : ''
              }`}
            >
              <span className="font-mono text-lg font-bold text-gray-800">#{c.serial || '—'}</span>
              {/* SalonBiz imports: the 5/18 "sale" is only the balance carried
                  over, so don't present it as a purchase date or buyer. */}
              <span className="font-mono text-base text-gray-700">
                {c.importedFromSalonBiz ? 'SalonBiz' : formatDate(c.purchaseDate)}
              </span>
              <span className="font-mono text-base font-semibold text-gray-800 truncate" title={c.soldByName ?? ''}>
                {c.importedFromSalonBiz ? '—' : (c.soldByName || '—')}
              </span>
              <span className="font-mono text-lg text-gray-800 truncate" title={c.purchaseClientName}>
                {c.importedFromSalonBiz ? '—' : c.purchaseClientName}
              </span>
              <span className="font-mono text-lg font-bold text-gray-900 text-right">{formatMoneyCents(c.valueCents)}</span>
              <span className={`font-mono text-lg font-bold text-right ${c.balanceCents > 0 ? 'text-emerald-600' : 'text-gray-400'}`}>
                {formatMoneyCents(c.balanceCents)}
              </span>
              <span className="font-mono text-base text-gray-700">
                {kind === 'open'
                  ? '—'
                  : <>
                      {formatDate(c.lastRedeemedDate ?? c.redeemedDate)}
                      {c.redemptionCount > 1 && (
                        <span className="text-gray-400"> · {c.redemptionCount} uses</span>
                      )}
                    </>}
              </span>
              <span className="font-mono text-lg text-gray-800 truncate" title={c.redeemedClientName ?? ''}>
                {kind === 'open' ? '—' : (c.redeemedClientName || '—')}
              </span>
            </button>
          ))}
         </div>
        </div>
      )}
    </div>
  );
}

function Kpi({
  label, value, accent, loading, sb, tm,
}: {
  label: string; value: string; accent?: 'emerald'; loading?: boolean;
  /** SalonBiz / TurnEm parts of `value` (the total). */
  sb?: string; tm?: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 px-5 py-5">
      <div className="font-mono text-sm font-bold text-gray-400 tracking-wider uppercase">{label}</div>
      {sb != null && tm != null && !loading && (
        <div className="mt-3 space-y-1 font-mono text-lg text-gray-600">
          <div className="flex justify-between gap-2"><span className="text-gray-400">SalonBiz</span><span className="font-semibold">{sb}</span></div>
          <div className="flex justify-between gap-2"><span className="text-gray-400">TurnEm</span><span className="font-semibold">{tm}</span></div>
        </div>
      )}
      <div className={`flex justify-between items-baseline gap-2 ${sb != null ? 'mt-1.5 pt-1.5 border-t border-gray-100' : 'mt-1'}`}>
        {sb != null && <span className="font-mono text-sm font-bold text-gray-400 uppercase tracking-wider">Total</span>}
        <span className={`font-mono text-4xl font-bold ${accent === 'emerald' ? 'text-emerald-600' : 'text-gray-900'}`}>
          {loading ? '…' : value}
        </span>
      </div>
    </div>
  );
}
