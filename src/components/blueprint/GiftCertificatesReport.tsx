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

import { useEffect, useMemo, useState } from 'react';
import { Search, Gift } from 'lucide-react';
import {
  fetchGiftCertificates,
  normalizeSerial,
  type GiftCertificate,
} from '../../lib/giftCertificates';
import { formatMoneyCents } from '../../lib/tickets';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00');
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  }).format(d);
}

export default function GiftCertificatesReport() {
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

  const filtered = useMemo(() => {
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

  const open = useMemo(() => filtered.filter((c) => c.redeemedAtMs == null), [filtered]);
  const used = useMemo(() => filtered.filter((c) => c.redeemedAtMs != null), [filtered]);

  const summary = useMemo(() => {
    const openValue = open.reduce((s, c) => s + c.valueCents, 0);
    const usedValue = used.reduce((s, c) => s + (c.redeemedAmountCents ?? c.valueCents), 0);
    return { openValue, usedValue, openCount: open.length, usedCount: used.length };
  }, [open, used]);

  return (
    <div className="p-6 overflow-y-auto h-full space-y-5">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Gift size={22} className="text-pink-500" />
          <h2 className="font-bebas text-2xl tracking-[3px] text-gray-900">GIFT CERTIFICATES</h2>
        </div>
        <label className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-2 min-w-[260px]">
          <Search size={14} className="text-gray-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search serial, date, or customer…"
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
      </div>

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
          {certs.map((c) => (
            <div
              key={`${c.purchaseTicketId}:${c.normalizedSerial || c.serial}`}
              className="grid grid-cols-[110px_120px_1fr_110px_120px_1fr_110px] gap-2 px-4 py-2.5 border-b border-gray-50 last:border-b-0 items-center"
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
