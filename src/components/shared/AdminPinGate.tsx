import { useState, useEffect, useRef } from 'react';
import { Lock, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../state/AuthContext';
import { recordPinAttempt } from '../../lib/pinAudit';

async function fetchAdminPin(): Promise<string | null> {
  const { data, error } = await supabase
    .from('system_state')
    .select('admin_passcode')
    .eq('id', 'singleton')
    .maybeSingle();
  if (error || !data) return null;
  return (data.admin_passcode as string) || null;
}

async function updateAdminPin(newPin: string): Promise<boolean> {
  const { error } = await supabase
    .from('system_state')
    .update({ admin_passcode: newPin, updated_at: new Date().toISOString() })
    .eq('id', 'singleton');
  return !error;
}

interface PinVerifyModalProps {
  isOpen: boolean;
  onSuccess: () => void;
  onCancel: () => void;
  title?: string;
  /** Which surface is being unlocked, e.g. 'history:previous-day'. Required so
   *  no gate can be added without saying what it protects — the audit row and
   *  the owner's push are both useless without it. */
  gate: string;
  /** What specifically, if there is one: the date being opened, the shift id. */
  detail?: string;
  /**
   * Personal PINs, used to NAME whoever is typing — pass them whether or not
   * they open this gate. Whether one of them also unlocks is `staffPinsUnlock`.
   *
   * Identifying on a REFUSAL is the point (Tony 2026-09-09): a receptionist's
   * code typed on a previous day's closed shift is still refused, but "DENISE
   * tried to open it" is something he can act on and "someone tried" is not.
   * Matched before the master PIN, so the common case needs no round-trip.
   *
   * Two people sharing a code would report as the first match — the salon
   * doesn't do that today, and the alternative (refusing to name anyone) loses
   * the name in every honest case to hedge against one that doesn't happen.
   */
  staffPins?: Array<{ pin: string; name: string }>;
  /** True where a personal code is allowed to open this gate — a receptionist
   *  may reopen TODAY's closed shift, but not a previous day's. */
  staffPinsUnlock?: boolean;
  /** Shown when a real staff code is refused because `staffPinsUnlock` is off.
   *  Says why the code is right but the day is wrong. */
  staffPinDeniedMessage?: string;
}


export function PinVerifyModal({
  isOpen,
  onSuccess,
  onCancel,
  title = 'Enter Admin PIN',
  gate,
  detail,
  staffPins,
  staffPinsUnlock = false,
  staffPinDeniedMessage = 'That code does not open this — Admin PIN required.',
}: PinVerifyModalProps) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setPin('');
      setError('');
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pin) return;
    setError('');

    // Personal PINs first — a match here needs no server call, and records the
    // name so neither the log nor the alert reads as an admin unlock.
    const staff = (staffPins ?? []).find((p) => p.pin && p.pin === pin);
    if (staff && staffPinsUnlock) {
      recordPinAttempt(gate, detail, 'granted', true, staff.name);
      onSuccess();
      return;
    }
    if (staff) {
      // Right person, wrong surface: a real code that this gate doesn't accept.
      // Refused, but logged and pushed BY NAME — that's the whole reason the
      // full staff list is passed in even where it cannot unlock anything.
      recordPinAttempt(gate, detail, 'denied', true, staff.name);
      setError(staffPinDeniedMessage);
      setPin('');
      setTimeout(() => inputRef.current?.focus(), 0);
      return;
    }

    setLoading(true);
    const current = await fetchAdminPin();
    setLoading(false);
    if (current === null) {
      setError('Could not reach server');
      return;
    }
    if (pin === current) {
      recordPinAttempt(gate, detail, 'granted');
      onSuccess();
    } else {
      recordPinAttempt(gate, detail, 'denied');
      setError('Incorrect PIN');
      setPin('');
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center">
              <Lock size={18} className="text-gray-600" />
            </div>
            <h2 className="font-bebas text-2xl tracking-[1.5px] text-gray-900">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-gray-400 hover:text-gray-600"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            value={pin}
            onChange={(e) => {
              setPin(e.target.value);
              setError('');
            }}
            className={`w-full px-4 py-3 rounded-xl border font-mono text-lg text-center tracking-widest focus:outline-none ${
              error
                ? 'border-red-300 bg-red-50 text-red-600'
                : 'border-gray-200 text-gray-900 focus:border-gray-400'
            }`}
            placeholder="PIN"
            autoComplete="off"
          />
          {error && (
            <p className="mt-2 font-mono text-xs text-red-500 text-center">{error}</p>
          )}
          <div className="flex gap-2 mt-4">
            <button
              type="button"
              onClick={onCancel}
              className="flex-1 py-2.5 rounded-xl border border-gray-200 text-gray-600 font-mono text-xs font-semibold"
            >
              CANCEL
            </button>
            <button
              type="submit"
              disabled={loading || !pin}
              className="flex-1 py-2.5 rounded-xl bg-gray-900 text-white font-mono text-xs font-semibold disabled:opacity-50"
            >
              {loading ? 'CHECKING...' : 'UNLOCK'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface ChangePinModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ChangePinModal({ isOpen, onClose }: ChangePinModalProps) {
  const { user } = useAuth();
  const [resetLoading, setResetLoading] = useState(false);
  const [resetMessage, setResetMessage] = useState<string | null>(null);

  async function handleResetLoginPassword() {
    setResetLoading(true);
    setResetMessage(null);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user?.email) {
        setResetMessage('No login email found');
        return;
      }
      const { error: resetErr } = await supabase.auth.resetPasswordForEmail(user.email, { redirectTo: window.location.origin });
      if (resetErr) setResetMessage(resetErr.message);
      else setResetMessage(`Reset link sent to ${user.email}`);
    } catch (e: unknown) {
      setResetMessage(e instanceof Error ? e.message : 'Failed to send reset link');
    } finally {
      setResetLoading(false);
    }
  }

  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setCurrentPin('');
      setNewPin('');
      setConfirmPin('');
      setError('');
      setSuccess(false);
      setLoading(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (newPin.length < 4) {
      setError('New PIN must be at least 4 digits');
      return;
    }
    if (newPin !== confirmPin) {
      setError('New PIN and confirmation do not match');
      return;
    }
    setLoading(true);
    const current = await fetchAdminPin();
    if (current === null) {
      setLoading(false);
      setError('Could not reach server');
      return;
    }
    if (current !== currentPin) {
      setLoading(false);
      setError('Current PIN is incorrect');
      return;
    }
    const ok = await updateAdminPin(newPin);
    setLoading(false);
    if (ok) {
      setSuccess(true);
      setTimeout(onClose, 1500);
    } else {
      setError('Could not update — try again');
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <h2 className="font-bebas text-2xl tracking-[1.5px] text-gray-900">ADMIN</h2>
              {user?.email && (
                <p className="font-mono text-xs text-gray-500 truncate max-w-[220px]">{user.email}</p>
              )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        {success ? (
          <div className="py-6 text-center">
            <p className="font-mono text-sm text-emerald-600 font-semibold">PIN updated</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="block font-mono text-[10px] text-gray-400 font-semibold mb-1 tracking-wider">
                CURRENT PIN
              </label>
              <input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                value={currentPin}
                onChange={(e) => setCurrentPin(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 font-mono text-gray-900 focus:outline-none focus:border-gray-400"
                autoComplete="off"
              />
            </div>
            <div>
              <label className="block font-mono text-[10px] text-gray-400 font-semibold mb-1 tracking-wider">
                NEW PIN
              </label>
              <input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                value={newPin}
                onChange={(e) => setNewPin(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 font-mono text-gray-900 focus:outline-none focus:border-gray-400"
                autoComplete="off"
              />
            </div>
            <div>
              <label className="block font-mono text-[10px] text-gray-400 font-semibold mb-1 tracking-wider">
                CONFIRM NEW PIN
              </label>
              <input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                value={confirmPin}
                onChange={(e) => setConfirmPin(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl border border-gray-200 font-mono text-gray-900 focus:outline-none focus:border-gray-400"
                autoComplete="off"
              />
            </div>
            {error && <p className="font-mono text-xs text-red-500">{error}</p>}
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-gray-600 font-mono text-xs font-semibold"
              >
                CANCEL
              </button>
              <button
                type="submit"
                disabled={loading || !currentPin || !newPin || !confirmPin}
                className="flex-1 py-2.5 rounded-xl bg-gray-900 text-white font-mono text-xs font-semibold disabled:opacity-50"
              >
                {loading ? 'SAVING...' : 'UPDATE PIN'}
              </button>
            </div>
          </form>
        )}
        <div className="mt-4 pt-4 border-t border-gray-100">
          <button
            type="button"
            onClick={handleResetLoginPassword}
            disabled={resetLoading}
            className="w-full py-2.5 rounded-xl border border-gray-200 text-gray-600 font-mono text-xs font-semibold tracking-[1.5px] hover:bg-gray-50 disabled:opacity-60"
          >
            {resetLoading ? 'SENDING...' : 'RESET LOGIN PASSWORD'}
          </button>
          {resetMessage && (
            <p className="mt-2 font-mono text-xs text-center text-gray-500">{resetMessage}</p>
          )}
        </div>
      </div>
    </div>
  );
}
