// GiftCardSaleModal — opened from the ADD GIFT button on TicketModal.
//
// Shows a sequential auto-generated serial number, a Staff selector (which
// receptionist sold the card), and a Gift Value input. On Add, the parent
// ticket gets a new gift_card_sale line item named "Gift Certificate
// #XXXXX" with the entered value as its price and the chosen staff on
// staff1 so the sale gets credited correctly.

import { useEffect, useMemo, useState } from 'react';
import { Gift, X } from 'lucide-react';
import { nextGiftCardSerial, parseDollarsToCents } from '../../lib/tickets';
import { useApp } from '../../state/AppContext';

export interface GiftSaleStaff {
  id: string | null;
  name: string;
  color: string;
}

interface Props {
  onClose: () => void;
  onAdd: (serial: string, valueCents: number, staff: GiftSaleStaff) => void;
}

export default function GiftCardSaleModal({ onClose, onAdd }: Props) {
  const { state } = useApp();

  const [serial, setSerial] = useState<string>('…');
  const [valueInput, setValueInput] = useState<string>('0.00');
  const [staffId, setStaffId] = useState<string>('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Sorted staff list — receptionists first (when the flag is set), then
  // everyone else, so the cashier sees front-desk choices at the top.
  const staff = useMemo(() => {
    const all = [...state.manicurists].sort((a, b) => a.name.localeCompare(b.name));
    return [
      ...all.filter((m) => m.isReceptionist),
      ...all.filter((m) => !m.isReceptionist),
    ];
  }, [state.manicurists]);

  // Pull the next sequential serial when the modal mounts.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = await nextGiftCardSerial();
      if (!cancelled) {
        setSerial(next);
        setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Esc closes
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function handleAdd() {
    const cents = parseDollarsToCents(valueInput);
    if (cents <= 0) {
      setError('Enter a gift value greater than $0.');
      return;
    }
    if (!staffId) {
      setError('Pick which staff member sold this gift card.');
      return;
    }
    if (busy) {
      setError('Serial number is still loading — try again in a moment.');
      return;
    }
    const m = state.manicurists.find((mm) => mm.id === staffId) ?? null;
    onAdd(serial, cents, {
      id: m?.id ?? null,
      name: m?.name ?? '',
      color: m?.color ?? '#9ca3af',
    });
    onClose();
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md flex flex-col animate-modal-in">
        {/* Header */}
        <div className="px-6 py-5 border-b border-gray-100 flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-pink-50 border border-pink-200 flex items-center justify-center text-pink-600">
            <Gift size={24} />
          </div>
          <div className="flex-1">
            <h2 className="font-bebas text-2xl tracking-widest text-gray-900">GIFT CERTIFICATE</h2>
            <p className="font-mono text-sm text-gray-500">Sell a new gift card to this client</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 flex flex-col gap-4">
          <div>
            <label className="font-mono text-sm tracking-wider font-semibold text-gray-400 uppercase">Serial Number</label>
            <div className="mt-1 px-3 py-2.5 rounded-lg border border-gray-200 bg-gray-50 font-mono text-base text-gray-700 select-all">
              #{serial}
            </div>
            <p className="mt-1 font-mono text-sm text-gray-400">
              Auto-generated, sequential. Write this on the physical certificate.
            </p>
          </div>

          <div>
            <label className="font-mono text-sm tracking-wider font-semibold text-gray-400 uppercase">Sold By</label>
            <select
              value={staffId}
              onChange={(e) => { setStaffId(e.target.value); setError(null); }}
              className="mt-1 w-full px-3 py-2.5 rounded-lg border border-gray-200 font-mono text-base bg-white focus:outline-none focus:border-pink-400"
            >
              <option value="">— Select staff —</option>
              {staff.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}{m.isReceptionist ? ' (front desk)' : ''}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="font-mono text-sm tracking-wider font-semibold text-gray-400 uppercase">Gift Value</label>
            <div className="mt-1 flex items-center gap-2">
              <span className="font-mono text-lg text-gray-400">$</span>
              <input
                type="text"
                inputMode="decimal"
                value={valueInput}
                onChange={(e) => { setValueInput(e.target.value); setError(null); }}
                onBlur={(e) => setValueInput((parseDollarsToCents(e.target.value) / 100).toFixed(2))}
                autoFocus
                className="flex-1 px-3 py-2.5 rounded-lg border border-gray-200 font-mono text-base focus:outline-none focus:border-pink-400"
                placeholder="0.00"
              />
            </div>
          </div>

          {error && (
            <p className="font-mono text-sm text-red-500">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 font-mono text-xs font-bold"
          >
            CANCEL
          </button>
          <button
            onClick={handleAdd}
            disabled={busy}
            className="px-4 py-2 rounded-lg bg-pink-600 text-white hover:bg-pink-700 font-mono text-xs font-bold disabled:opacity-50"
          >
            ADD GIFT CARD
          </button>
        </div>
      </div>
    </div>
  );
}
