// OpenShiftModal — count the starting drawer cash by denomination, identify
// the receptionist with their PIN, then open.
//
// The total cents, the breakdown, and the receptionist id all persist to
// the shift row so reports can attribute the open to a real person.

import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { openShift } from '../../lib/shifts';
import MoneyCountTable, {
  totalFromCount,
  type DenominationCount,
} from './MoneyCountTable';
import { formatMoneyCents } from '../../lib/tickets';
import type { Manicurist } from '../../types';

interface Props {
  /** Receptionist roster — only these can identify themselves on the PIN gate. */
  receptionists: Manicurist[];
  onClose: () => void;
  onOpened: () => void;
}

export default function OpenShiftModal({ receptionists, onClose, onOpened }: Props) {
  const [count, setCount] = useState<DenominationCount>({});
  const [receptionistId, setReceptionistId] = useState<string>('');
  const [pin, setPin] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pinRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Auto-focus the PIN input on mount AND re-focus when the receptionist
  // dropdown changes. Either workflow works — type PIN first then pick
  // from dropdown, or pick from dropdown then PIN is already focused.
  useEffect(() => {
    const t = setTimeout(() => pinRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [receptionistId]);

  const selected = useMemo(
    () => receptionists.find((r) => r.id === receptionistId) ?? null,
    [receptionists, receptionistId],
  );

  async function handleOpen() {
    setError(null);
    if (!selected) {
      setError('Pick a receptionist first.');
      return;
    }
    // Compare against the receptionist's own pin_code. A missing or empty
    // pin on the roster means "no pin set" — refuse rather than auto-pass.
    if (!selected.pinCode) {
      setError(`${selected.name} has no PIN configured. Set one in Staff before opening.`);
      return;
    }
    if (pin !== selected.pinCode) {
      setError('Incorrect PIN.');
      return;
    }
    setBusy(true);
    const cents = totalFromCount(count);
    const shift = await openShift(cents, count, selected.id);
    setBusy(false);
    if (!shift) {
      setError('Could not open shift — try again.');
      return;
    }
    onOpened();
  }

  const totalCents = totalFromCount(count);
  const canOpen = !busy && !!selected && pin.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col animate-modal-in">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-bebas text-2xl tracking-widest text-gray-900">OPEN SHIFT</h2>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>
        <div className="px-6 py-5 flex flex-col gap-4 overflow-y-auto">
          <p className="font-mono text-xs text-gray-500">
            Count the cash in the drawer by denomination. The total below becomes
            the opening balance.
          </p>
          <MoneyCountTable
            value={count}
            onChange={setCount}
            hideCoins
            billsAscending
            hideTotal
          />
          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-gray-100">
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-wider text-gray-500">Receptionist</span>
              <select
                value={receptionistId}
                onChange={(e) => { setReceptionistId(e.target.value); setPin(''); setError(null); }}
                className="px-3 py-2 rounded-lg border border-gray-200 font-mono text-sm bg-white focus:outline-none focus:ring-2 focus:ring-pink-300"
              >
                <option value="">Select…</option>
                {receptionists.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-wider text-gray-500">PIN</span>
              <input
                ref={pinRef}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                value={pin}
                onChange={(e) => { setPin(e.target.value); setError(null); }}
                className="px-3 py-2 rounded-lg border border-gray-200 font-mono text-sm tracking-widest focus:outline-none focus:ring-2 focus:ring-pink-300"
                placeholder="••••"
              />
            </label>
          </div>
          {error && <p className="font-mono text-xs text-red-500">{error}</p>}
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between gap-3">
          <div className="flex flex-col">
            <span className="font-mono text-[10px] uppercase tracking-wider text-gray-500">
              Starting cash
            </span>
            <span className="font-mono text-2xl font-bold text-emerald-600">
              {formatMoneyCents(totalCents)}
            </span>
          </div>
          <div className="flex gap-2">
            <button onClick={onClose}
              className="px-4 py-2 rounded-lg border border-gray-200 text-gray-600 font-mono text-xs font-bold hover:bg-gray-50">
              CANCEL
            </button>
            <button onClick={handleOpen} disabled={!canOpen}
              className="px-4 py-2 rounded-lg bg-gray-900 text-white font-mono text-xs font-bold hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed">
              {busy ? 'OPENING…' : 'OPEN SHIFT'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
