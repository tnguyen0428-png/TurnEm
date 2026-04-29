// CloseShiftScreen — SalonBiz-mirrored Close Shift surface.
//
// Tabs: Payments Summary, Reconcile Cash.
//
// Payments Summary: per-tender table (Cash / Visa-MC / Gift) with Starting,
// # Pays, Payments, Change Out, Drawer +/-, You Have.
//
// Reconcile Cash: denomination count table (bills + coins) for what's actually
// in the drawer. Variance = counted - expected. A note is required when
// variance != 0. Close Shift writes declared, expected, variance, note, and
// the closing denomination count.

import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import {
  closeShift,
  computeShiftBalance,
  type ShiftBalanceLine,
} from '../../lib/shifts';
import { formatMoneyCents } from '../../lib/tickets';
import type { Shift } from '../../types';
import MoneyCountTable, {
  totalFromCount,
  type DenominationCount,
} from './MoneyCountTable';

interface Props {
  shift: Shift;
  onClose: () => void;
  onClosed: () => void;
}

type Tab = 'summary' | 'reconcile';

export default function CloseShiftScreen({ shift, onClose, onClosed }: Props) {
  const [tab, setTab] = useState<Tab>('summary');
  const [lines, setLines] = useState<ShiftBalanceLine[]>([]);
  const [expectedCashCents, setExpectedCashCents] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await computeShiftBalance(shift.id);
    if (result) {
      setLines(result.lines);
      setExpectedCashCents(result.expectedCashCents);
    }
    setLoading(false);
  }, [shift.id]);

  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  // ─── Closing denomination count ───────────────────────────────────────────
  const [closingCount, setClosingCount] = useState<DenominationCount>({});
  const declaredCents = totalFromCount(closingCount);
  const varianceCents = declaredCents - expectedCashCents;
  const [varianceNote, setVarianceNote] = useState('');

  // ─── Close-shift action ───────────────────────────────────────────────────
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function handleCloseShift() {
    setError(null);
    if (varianceCents !== 0 && !varianceNote.trim()) {
      setError('Variance is non-zero — please add a note explaining why.');
      return;
    }
    setBusy(true);
    const closed = await closeShift({
      shiftId: shift.id,
      declaredCashCents: declaredCents,
      expectedCashCents,
      varianceNote: varianceNote.trim(),
      closingCount,
    });
    setBusy(false);
    if (!closed) {
      setError('Could not close shift — try again.');
      return;
    }
    onClosed();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col animate-modal-in">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <h2 className="font-bebas text-2xl tracking-widest text-gray-900">CLOSE SHIFT</h2>
            <p className="font-mono text-xs text-gray-400 mt-0.5">
              Drawer #{shift.drawerNumber} — opened {new Date(shift.openedAt).toLocaleString()}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setRefreshKey((k) => k + 1)}
              className="px-3 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 font-mono text-[10px] font-semibold tracking-wider">
              REFRESH
            </button>
            <button onClick={onClose}
              className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="px-6 pt-3 border-b border-gray-100 flex items-center gap-1">
          <TabBtn active={tab === 'summary'} onClick={() => setTab('summary')}>
            PAYMENTS SUMMARY
          </TabBtn>
          <TabBtn active={tab === 'reconcile'} onClick={() => setTab('reconcile')}>
            RECONCILE CASH
          </TabBtn>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="text-center font-mono text-xs text-gray-400 py-12">Computing balance…</div>
          ) : tab === 'summary' ? (
            <PaymentsSummary lines={lines} />
          ) : (
            <ReconcileCash
              expectedCashCents={expectedCashCents}
              count={closingCount}
              setCount={setClosingCount}
              declaredCents={declaredCents}
              varianceCents={varianceCents}
              varianceNote={varianceNote}
              setVarianceNote={setVarianceNote}
            />
          )}
        </div>

        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between gap-3">
          {error && <p className="font-mono text-xs text-red-500">{error}</p>}
          <div className="ml-auto flex items-center gap-2">
            <button onClick={onClose}
              className="px-4 py-2 rounded-lg border border-gray-200 text-gray-600 font-mono text-xs font-bold hover:bg-gray-50">
              CANCEL
            </button>
            <button onClick={handleCloseShift} disabled={busy}
              className="px-4 py-2 rounded-lg bg-gray-900 text-white font-mono text-xs font-bold hover:bg-gray-800 disabled:opacity-50">
              {busy ? 'CLOSING…' : 'CLOSE SHIFT'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TabBtn({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 font-mono text-[11px] tracking-wider font-bold rounded-t-lg ${
        active ? 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-gray-50'
      }`}
    >
      {children}
    </button>
  );
}

function PaymentsSummary({ lines }: { lines: ShiftBalanceLine[] }) {
  return (
    <div className="border border-gray-100 rounded-xl overflow-hidden">
      <div className="grid grid-cols-[100px_repeat(6,_1fr)] gap-2 px-3 py-2 bg-gray-50 border-b border-gray-100 font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">
        <span></span>
        <span className="text-right">Starting</span>
        <span className="text-right"># Pays</span>
        <span className="text-right">Payments</span>
        <span className="text-right">Change Out</span>
        <span className="text-right">Drawer +/-</span>
        <span className="text-right">You Have</span>
      </div>
      {lines.map((line) => (
        <div key={line.method}
          className="grid grid-cols-[100px_repeat(6,_1fr)] gap-2 px-3 py-3 border-b border-gray-50 last:border-b-0 items-center">
          <span className="font-bebas text-base tracking-wider text-gray-900">
            {line.method === 'visa_mc' ? 'CREDIT CARD' : line.method.toUpperCase()}
          </span>
          <span className="font-mono text-sm text-gray-700 text-right">
            {line.method === 'cash' ? formatMoneyCents(line.startingBalanceCents) : '—'}
          </span>
          <span className="font-mono text-sm text-gray-700 text-right">{line.paymentCount}</span>
          <span className="font-mono text-sm text-gray-700 text-right">{formatMoneyCents(line.paymentAmountCents)}</span>
          <span className="font-mono text-sm text-gray-700 text-right">
            {line.method === 'cash' ? formatMoneyCents(line.changeOutCents) : '—'}
          </span>
          <span className="font-mono text-sm text-gray-700 text-right">
            {line.method === 'cash' ? formatMoneyCents(line.drawerEntriesCents) : '—'}
          </span>
          <span className="font-mono text-sm font-bold text-gray-900 text-right">
            {formatMoneyCents(line.youHaveCents)}
          </span>
        </div>
      ))}
    </div>
  );
}

function ReconcileCash({
  expectedCashCents, count, setCount, declaredCents, varianceCents,
  varianceNote, setVarianceNote,
}: {
  expectedCashCents: number;
  count: DenominationCount;
  setCount: (next: DenominationCount) => void;
  declaredCents: number;
  varianceCents: number;
  varianceNote: string;
  setVarianceNote: (v: string) => void;
}) {
  const isOver = varianceCents > 0;
  const isShort = varianceCents < 0;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
      <div className="flex flex-col gap-4">
        <p className="font-mono text-xs text-gray-500">
          Count the actual cash in the drawer by denomination. Variance = counted − expected.
        </p>
        <MoneyCountTable value={count} onChange={setCount} />
        <div>
          <label className="font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">
            Variance Note {varianceCents !== 0 && <span className="text-red-500">*required</span>}
          </label>
          <textarea
            value={varianceNote} onChange={(e) => setVarianceNote(e.target.value)}
            rows={3}
            className="mt-1 w-full px-3 py-2 rounded-lg border border-gray-200 font-mono text-sm focus:outline-none focus:border-gray-400 resize-none"
            placeholder="e.g. tip-out paid in cash; missed pay-out entry"
          />
        </div>
      </div>
      <div className="bg-gray-50 rounded-xl p-5 flex flex-col gap-3 self-start">
        <Row label="Expected Cash" value={formatMoneyCents(expectedCashCents)} />
        <Row label="Counted Cash" value={formatMoneyCents(declaredCents)} />
        <div className="border-t border-gray-200 my-1" />
        <div className="flex items-center justify-between">
          <span className="font-mono text-xs text-gray-500">Variance</span>
          <span className={`font-mono text-lg font-bold ${
            isOver ? 'text-emerald-600' : isShort ? 'text-red-500' : 'text-gray-900'
          }`}>
            {(varianceCents > 0 ? '+' : '') + formatMoneyCents(varianceCents)}
          </span>
        </div>
        {varianceCents === 0 && declaredCents > 0 && (
          <p className="font-mono text-xs text-emerald-600 mt-1">✓ Drawer balances.</p>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="font-mono text-xs text-gray-500">{label}</span>
      <span className="font-mono text-base font-bold text-gray-900">{value}</span>
    </div>
  );
}
