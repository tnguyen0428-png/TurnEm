// OpenShiftModal — count the starting drawer cash by denomination, then open.
// The total cents and the breakdown both persist to the shift row.

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { openShift } from '../../lib/shifts';
import MoneyCountTable, {
  totalFromCount,
  type DenominationCount,
} from './MoneyCountTable';
import { formatMoneyCents } from '../../lib/tickets';

interface Props {
  onClose: () => void;
  onOpened: () => void;
}

export default function OpenShiftModal({ onClose, onOpened }: Props) {
  const [count, setCount] = useState<DenominationCount>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleOpen() {
    setError(null);
    setBusy(true);
    const cents = totalFromCount(count);
    const shift = await openShift(cents, count);
    setBusy(false);
    if (!shift) {
      setError('Could not open shift — try again.');
      return;
    }
    onOpened();
  }

  const totalCents = totalFromCount(count);

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
          <MoneyCountTable value={count} onChange={setCount} />
          {error && <p className="font-mono text-xs text-red-500">{error}</p>}
        </div>
        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between gap-3">
          <span className="font-mono text-xs text-gray-500">
            Starting cash: <span className="font-bold text-gray-900">{formatMoneyCents(totalCents)}</span>
          </span>
          <div className="flex gap-2">
            <button onClick={onClose}
              className="px-4 py-2 rounded-lg border border-gray-200 text-gray-600 font-mono text-xs font-bold hover:bg-gray-50">
              CANCEL
            </button>
            <button onClick={handleOpen} disabled={busy}
              className="px-4 py-2 rounded-lg bg-gray-900 text-white font-mono text-xs font-bold hover:bg-gray-800 disabled:opacity-50">
              {busy ? 'OPENING…' : 'OPEN SHIFT'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
