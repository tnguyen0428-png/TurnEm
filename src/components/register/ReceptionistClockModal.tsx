// ReceptionistClockModal — PIN-gated clock-in / clock-out for receptionists.
//
// Triggered from the Register screen's sun/moon pill. Flow:
//   1. Receptionist enters their passcode (PIN).
//   2. Their name + the current time appears, with the action (CLOCK IN or
//      CLOCK OUT) derived from whether they're currently clocked in.
//   3. They confirm. We write the clock_events row FIRST (the durable,
//      cross-device log), then dispatch the CLOCK_IN/CLOCK_OUT toggle via the
//      parent callbacks. Writing the event first means a failed DB write
//      leaves nothing changed, so the synced `clockedIn` flag and the hours
//      log can't drift apart.
//
// The parent owns the store dispatch (onClockIn/onClockOut); this component
// owns the PIN check, the confirm step, and the clock_events append.

import { useEffect, useRef, useState } from 'react';
import { X, Lock, Sun, Moon, ArrowLeft } from 'lucide-react';
import { appendEvent as appendClockEvent } from '../../lib/clockLog';
import type { Manicurist } from '../../types';

interface Props {
  receptionists: Manicurist[];
  onClose: () => void;
  onClockIn: (id: string) => void;
  onClockOut: (id: string) => void;
}

type Stage =
  | { name: 'pin' }
  | { name: 'confirm'; receptionist: Manicurist; action: 'in' | 'out'; at: number };

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(ms));
}

export default function ReceptionistClockModal({
  receptionists,
  onClose,
  onClockIn,
  onClockOut,
}: Props) {
  const [stage, setStage] = useState<Stage>({ name: 'pin' });
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);

  // Live-updating "now" so the confirm screen's clock ticks while the
  // receptionist reads it. The actual event is stamped at confirm-press time.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Esc cancels.
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Auto-focus the PIN box on mount.
  useEffect(() => {
    if (stage.name === 'pin') {
      const t = setTimeout(() => pinRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [stage.name]);

  function submitPin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // Identify the receptionist purely by PIN. First match wins — PINs are
    // personal credentials, unique per receptionist.
    const match = receptionists.find((r) => r.pinCode && r.pinCode === pin);
    if (!match) {
      setError('Incorrect PIN.');
      setPin('');
      setTimeout(() => pinRef.current?.focus(), 0);
      return;
    }
    setStage({
      name: 'confirm',
      receptionist: match,
      action: match.clockedIn ? 'out' : 'in',
      at: Date.now(),
    });
  }

  function backToPin() {
    setStage({ name: 'pin' });
    setPin('');
    setError(null);
  }

  async function confirm() {
    if (stage.name !== 'confirm' || saving) return;
    setSaving(true);
    setError(null);
    const { receptionist, action } = stage;
    // Write the durable log row first; only flip the synced toggle if it lands.
    const ev = await appendClockEvent(receptionist.id, receptionist.name, action);
    if (!ev) {
      setError('Could not save — check the connection and try again.');
      setSaving(false);
      return;
    }
    if (action === 'in') onClockIn(receptionist.id);
    else onClockOut(receptionist.id);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm flex flex-col animate-modal-in">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-bebas text-2xl tracking-widest text-gray-900">TIME CLOCK</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600"
          >
            <X size={18} />
          </button>
        </div>

        {stage.name === 'pin' ? (
          /* ── Stage 1: passcode ─────────────────────────────────────────── */
          <form onSubmit={submitPin} className="px-6 py-6 flex flex-col gap-4">
            <div className="flex items-center gap-2 text-gray-500">
              <Lock size={15} />
              <span className="font-mono text-xs">Enter your passcode to clock in or out.</span>
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
          /* ── Stage 2: name + time + confirm ────────────────────────────── */
          <div className="px-6 py-6 flex flex-col items-center gap-4">
            <div
              className={`flex items-center gap-2 px-3 py-1 rounded-full font-mono text-[11px] font-bold tracking-widest ${
                stage.action === 'in'
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-indigo-50 text-indigo-700'
              }`}
            >
              {stage.action === 'in' ? <Sun size={13} /> : <Moon size={13} />}
              {stage.action === 'in' ? 'CLOCK IN' : 'CLOCK OUT'}
            </div>

            <div className="text-center">
              <div className="flex items-center justify-center gap-2">
                <span
                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: stage.receptionist.color }}
                />
                <span className="font-bebas text-3xl tracking-wide text-gray-900">
                  {stage.receptionist.name}
                </span>
              </div>
              <div className="font-mono text-2xl font-semibold text-gray-700 mt-2 tabular-nums">
                {formatTime(now)}
              </div>
            </div>

            {error && <p className="font-mono text-xs text-red-500 text-center">{error}</p>}

            <div className="flex gap-2 w-full mt-1">
              <button
                onClick={backToPin}
                disabled={saving}
                className="flex items-center justify-center gap-1.5 px-3 py-3 rounded-xl border border-gray-200 text-gray-600 font-mono text-xs font-bold hover:bg-gray-50 disabled:opacity-50"
              >
                <ArrowLeft size={14} /> BACK
              </button>
              <button
                onClick={confirm}
                disabled={saving}
                className={`flex-1 py-3 rounded-xl text-white font-mono text-xs font-bold tracking-widest disabled:opacity-60 ${
                  stage.action === 'in'
                    ? 'bg-emerald-600 hover:bg-emerald-700'
                    : 'bg-indigo-600 hover:bg-indigo-700'
                }`}
              >
                {saving
                  ? 'SAVING…'
                  : stage.action === 'in' ? 'CONFIRM CLOCK IN' : 'CONFIRM CLOCK OUT'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
