// ReceptionistPinGate — reusable PIN-confirm modal for destructive actions.
//
// Pattern: a parent component flags an intent (e.g. "void this ticket"),
// renders this gate with the receptionist roster, and on confirm receives
// the receptionist id of whoever entered the matching PIN. The parent
// performs the actual destructive action (DB write, reducer dispatch) only
// after onConfirm fires.
//
// Used by the ticket VOID flow in TicketModal and the completed-service
// VOID/UN-VOID flow in EditCompletedModal so reports can attribute the
// action to a real receptionist instead of just the logged-in cashier.

import { useEffect, useRef, useState } from 'react';
import { Lock, X } from 'lucide-react';
import type { Manicurist } from '../../types';

interface Props {
  open: boolean;
  title: string;
  /** Description rendered under the title (e.g. "Voiding Ticket #42"). */
  subtitle?: string;
  /** Optional reason input above the PIN row. When provided, the entered value
   *  is passed back as the second arg to onConfirm. */
  showReason?: boolean;
  reasonPlaceholder?: string;
  confirmLabel: string;
  /** Tone of the confirm button. 'danger' = red, 'primary' = gray-900. */
  tone?: 'danger' | 'primary';
  receptionists: Manicurist[];
  /** When true, hide the receptionist dropdown and identify the user
   *  purely by their PIN. The first matching receptionist wins. */
  pinOnly?: boolean;
  onCancel: () => void;
  onConfirm: (receptionistId: string, reason: string) => void;
}

export default function ReceptionistPinGate({
  open,
  title,
  subtitle,
  showReason = false,
  reasonPlaceholder = 'Reason (optional)',
  confirmLabel,
  tone = 'primary',
  receptionists,
  pinOnly = false,
  onCancel,
  onConfirm,
}: Props) {
  const [receptionistId, setReceptionistId] = useState('');
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pinRef = useRef<HTMLInputElement>(null);

  // Reset state every time the gate opens so previous values don't linger
  // between two unrelated void attempts.
  useEffect(() => {
    if (open) {
      setReceptionistId('');
      setPin('');
      setReason('');
      setError(null);
    }
  }, [open]);

  // Esc cancels.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  // Auto-focus the PIN input so the user can just start typing without
  // having to click into the box. In pinOnly mode focus immediately on
  // open; in roster mode wait until they've picked a receptionist (so the
  // first interaction is the dropdown, then PIN comes into focus as soon
  // as it's actionable). 50ms delay matches the other gates' timing —
  // beats React's commit + modal mount paint.
  useEffect(() => {
    if (!open) return;
    if (pinOnly || receptionistId) {
      const t = setTimeout(() => pinRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open, pinOnly, receptionistId]);

  if (!open) return null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (pinOnly) {
      // Identify receptionist purely by PIN. First match wins; this works
      // because PINs are personal credentials (unique per receptionist).
      const match = receptionists.find((r) => r.pinCode && r.pinCode === pin);
      if (!match) {
        setError('Incorrect PIN.');
        setPin('');
        setTimeout(() => pinRef.current?.focus(), 0);
        return;
      }
      onConfirm(match.id, reason.trim());
      return;
    }
    const selected = receptionists.find((r) => r.id === receptionistId) ?? null;
    if (!selected) {
      setError('Pick a receptionist first.');
      return;
    }
    if (!selected.pinCode) {
      setError(`${selected.name} has no PIN configured. Set one in Staff before continuing.`);
      return;
    }
    if (pin !== selected.pinCode) {
      setError('Incorrect PIN.');
      setPin('');
      setTimeout(() => pinRef.current?.focus(), 0);
      return;
    }
    onConfirm(selected.id, reason.trim());
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Lock size={16} className="text-gray-400" />
            <h2 className="font-bebas text-xl tracking-widest text-gray-900">{title}</h2>
          </div>
          <button
            onClick={onCancel}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600"
          >
            <X size={16} />
          </button>
        </div>
        {subtitle && <p className="font-mono text-xs text-gray-500 -mt-2">{subtitle}</p>}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          {showReason && (
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-wider text-gray-500">Reason</span>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={reasonPlaceholder}
                className="px-3 py-2 rounded-lg border border-gray-200 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-pink-300"
              />
            </label>
          )}
          {!pinOnly && (
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
          )}
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-gray-500">PIN</span>
            <input
              ref={pinRef}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              value={pin}
              onChange={(e) => { setPin(e.target.value); setError(null); }}
              placeholder="••••"
              className="px-3 py-2 rounded-lg border border-gray-200 font-mono text-sm tracking-widest focus:outline-none focus:ring-2 focus:ring-pink-300"
            />
          </label>
          {error && <p className="font-mono text-xs text-red-500">{error}</p>}
          <div className="flex gap-2 justify-end mt-1">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 font-mono text-xs font-bold hover:bg-gray-50"
            >
              CANCEL
            </button>
            <button
              type="submit"
              disabled={pinOnly ? pin.length === 0 : (!receptionistId || pin.length === 0)}
              className={`px-4 py-1.5 rounded-lg font-mono text-xs font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                tone === 'danger'
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'bg-gray-900 text-white hover:bg-gray-800'
              }`}
            >
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
