// OpenShiftModal — identify the receptionist with their PIN first, then count
// the starting drawer cash by denomination, then open.
//
// The total cents, the breakdown, and the receptionist id all persist to
// the shift row so reports can attribute the open to a real person.

import { useEffect, useRef, useState } from 'react';
import { X, ArrowLeft, Lock } from 'lucide-react';
import { openShift } from '../../lib/shifts';
import { appendEvent as appendClockEvent } from '../../lib/clockLog';
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
  /** Clocks the opener in via the reducer, mirroring ReceptionistClockModal. */
  onClockIn: (id: string) => void;
}

type Stage = 'pin' | 'count';

export default function OpenShiftModal({ receptionists, onClose, onOpened, onClockIn }: Props) {
  const [stage, setStage] = useState<Stage>('pin');
  const [matched, setMatched] = useState<Manicurist | null>(null);
  const [pin, setPin] = useState<string>('');
  const [count, setCount] = useState<DenominationCount>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pinRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Auto-focus the PIN input whenever the pin stage is shown.
  useEffect(() => {
    if (stage === 'pin') {
      const t = setTimeout(() => pinRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [stage]);

  // The PIN itself identifies who is opening — first receptionist whose
  // personal pinCode matches wins. No name dropdown: whoever's PIN is entered
  // is recorded as the opener.
  function submitPin() {
    setError(null);
    if (pin.length === 0) {
      setError('Enter your PIN to continue.');
      return;
    }
    const found = receptionists.find((r) => r.pinCode && r.pinCode === pin) ?? null;
    if (!found) {
      setError('Incorrect PIN.');
      return;
    }
    setMatched(found);
    setStage('count');
  }

  function backToPin() {
    setStage('pin');
    setMatched(null);
    setPin('');
    setError(null);
  }

  async function handleOpen() {
    if (!matched) return;
    setError(null);
    const cents = totalFromCount(count);
    if (cents <= 0) {
      setError('Count the drawer first — the opening cash total can’t be $0.');
      return;
    }
    setBusy(true);
    const shift = await openShift(cents, count, matched.id);
    if (!shift) {
      setBusy(false);
      setError('Could not open shift — try again.');
      return;
    }
    // Clock the opener in at the moment the shift opens, same as the
    // Register's separate time-clock flow: durable clock_events row first,
    // then the reducer toggle. Skip if they're already clocked in so a
    // re-open doesn't stomp their real clock-in time (and their spot in
    // "Turns per Manicurist" order).
    if (!matched.clockedIn) {
      const ev = await appendClockEvent(matched.id, matched.name, 'in');
      if (ev) onClockIn(matched.id);
    }
    setBusy(false);
    onOpened();
  }

  const totalCents = totalFromCount(count);
  const canOpen = !busy && totalCents > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col animate-modal-in">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-bebas text-2xl tracking-widest text-gray-900">OPEN SHIFT</h2>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
            <X size={18} />
          </button>
        </div>

        {stage === 'pin' ? (
          /* ── Stage 1: passcode ─────────────────────────────────────────── */
          <form
            onSubmit={(e) => { e.preventDefault(); submitPin(); }}
            className="px-6 py-6 flex flex-col gap-4"
          >
            <div className="flex items-center gap-2 text-gray-500">
              <Lock size={15} />
              <span className="font-mono text-xs">Enter your PIN to open the shift.</span>
            </div>
            <input
              ref={pinRef}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={(e) => { setPin(e.target.value); setError(null); }}
              placeholder="••••"
              className="px-4 py-3 rounded-xl border border-gray-200 font-mono text-lg tracking-[0.4em] text-center focus:outline-none focus:ring-2 focus:ring-pink-300"
            />
            {error && <p className="font-mono text-xs text-red-500 text-center">{error}</p>}
            <button
              type="submit"
              disabled={pin.length === 0}
              className="w-full py-3 rounded-xl bg-gray-900 text-white font-mono text-xs font-bold tracking-widest hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              CONTINUE
            </button>
          </form>
        ) : (
          /* ── Stage 2: drawer count + confirm ────────────────────────────── */
          <>
            <div className="px-6 py-5 flex flex-col gap-4 overflow-y-auto">
              <div className="flex items-center justify-between">
                <p className="font-mono text-xs text-gray-500">
                  Count the cash in the drawer by denomination. The total below
                  becomes the opening balance.
                </p>
                {matched && (
                  <span className="font-mono text-[11px] text-emerald-600 whitespace-nowrap ml-3">
                    Opening as {matched.name}
                    {!matched.clockedIn && ' — clocks you in now'}
                  </span>
                )}
              </div>
              <MoneyCountTable
                value={count}
                onChange={setCount}
                hideCoins
                billsAscending
                hideTotal
              />
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
                <button onClick={backToPin} disabled={busy}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-gray-200 text-gray-600 font-mono text-xs font-bold hover:bg-gray-50 disabled:opacity-50">
                  <ArrowLeft size={14} /> BACK
                </button>
                <button onClick={handleOpen} disabled={!canOpen}
                  className="px-4 py-2 rounded-lg bg-gray-900 text-white font-mono text-xs font-bold hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed">
                  {busy ? 'OPENING…' : 'OPEN SHIFT'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
