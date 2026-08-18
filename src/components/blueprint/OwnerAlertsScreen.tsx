import { useCallback, useEffect, useState } from 'react';
import { BellRing, Loader2, ShieldCheck } from 'lucide-react';
import {
  isPushSupported,
  isOwnerAlertsOn,
  enableOwnerAlerts,
  disableOwnerAlerts,
} from '../../utils/pushNotifications';

// Owner-level notifications, enabled per DEVICE.
//
// Two things arrive here:
//   • the 11:30pm nightly report — what the reconciliation repaired and what
//     still disagrees between the floor and the register
//   • a sales summary each time a drawer is closed
//
// This is separate from the staff service alerts in the Staff Portal. Those are
// bound to the manicurist who is logged in; these are bound to a synthetic
// owner id, so turning them on here does not affect anyone's service alerts and
// does not put the owner on the board. Both can live on the same phone.
export default function OwnerAlertsScreen() {
  const [supported] = useState(() => isPushSupported());
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const state = await isOwnerAlertsOn();
      if (!cancelled) setOn(state);
    })();
    return () => { cancelled = true; };
  }, []);

  const toggle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = on ? await disableOwnerAlerts() : await enableOwnerAlerts();
      if (!res.ok) {
        setError(res.error ?? 'Unknown error');
        return;
      }
      setOn(!on);
    } finally {
      setBusy(false);
    }
  }, [busy, on]);

  return (
    <div className="p-6 max-w-2xl">
      <div className="bg-white rounded-2xl border border-gray-100 p-6">
        <div className="flex items-start gap-4">
          <div className="w-11 h-11 rounded-xl bg-pink-50 flex items-center justify-center flex-shrink-0">
            <BellRing size={20} className="text-pink-500" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-bebas text-xl tracking-[2px] text-gray-900 leading-none">
              OWNER ALERTS ON THIS DEVICE
            </h3>
            <p className="font-mono text-xs text-gray-500 mt-2 leading-relaxed">
              Sends the 11:30pm nightly report and a sales summary at every shift
              close to this phone. Turn it on once, on the phone you want them.
            </p>
          </div>
        </div>

        <div className="mt-5 pl-15">
          {!supported ? (
            <p className="font-mono text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-3 leading-relaxed">
              This browser cannot receive notifications. On iPhone, add the app to
              your home screen first (Share → Add to Home Screen), then open it
              from there and come back to this page.
            </p>
          ) : (
            <button
              onClick={toggle}
              disabled={busy || on === null}
              className={`px-5 py-2.5 rounded-xl font-mono text-sm font-semibold transition-colors disabled:opacity-50 ${
                on
                  ? 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  : 'bg-pink-500 text-white hover:bg-pink-600'
              }`}
            >
              {busy || on === null ? (
                <span className="flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" />
                  {on === null ? 'Checking…' : 'Working…'}
                </span>
              ) : on ? (
                'Turn off owner alerts'
              ) : (
                'Turn on owner alerts'
              )}
            </button>
          )}

          {on === true && !busy && (
            <p className="font-mono text-xs text-green-700 mt-3 flex items-center gap-2">
              <ShieldCheck size={14} className="flex-shrink-0" />
              This device is receiving owner alerts.
            </p>
          )}

          {error && (
            <p className="font-mono text-xs text-red-600 mt-3 leading-relaxed">
              Could not change it: {error}
            </p>
          )}
        </div>

        <p className="font-mono text-[11px] text-gray-400 mt-6 pt-4 border-t border-gray-50 leading-relaxed">
          Separate from the staff service alerts in the Staff Portal. Turning
          this on or off never affects a technician's own notifications, even on
          a shared phone.
        </p>
      </div>
    </div>
  );
}
