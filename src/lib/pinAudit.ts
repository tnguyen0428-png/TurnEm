import { supabase } from './supabase';
import { pushToOwners } from '../utils/pushNotifications';

/** Human-readable names for the owner's push. Falls back to the raw key, so a
 *  new gate still alerts correctly if someone forgets to add a label here. */
const GATE_LABELS: Record<string, string> = {
  'history:previous-day': 'History — opened a previous day',
  'history:clear': 'History — Clear History',
  'register:closed-shift': 'Register — opened a closed shift',
  'blueprint:receptionist-hours': 'Blueprint — edited receptionist hours',
  'blueprint:entry': 'Blueprint — opened',
};

/**
 * Record a master-PIN attempt and, by default, tell the owner.
 *
 * Fire-and-forget on both counts: a logging or network problem must never stop
 * someone unlocking a screen they hold the PIN for, and must never make them
 * wait for it. Denied attempts are recorded too — a run of them is somebody
 * trying codes, which is exactly what a success-only log would hide.
 *
 * `alertOwner` exists for gates staff reach routinely (Blueprint entry on a
 * receptionist's own PIN): still recorded, but pushing every time would bury
 * the alerts that matter under daily traffic.
 */
export function recordPinAttempt(
  gate: string,
  detail: string | undefined,
  outcome: 'granted' | 'denied',
  alertOwner = true,
) {
  void supabase
    .from('admin_pin_attempt_log')
    .insert({ gate, detail: detail ?? null, outcome })
    .then(({ error }) => {
      if (error) console.warn('[pin] attempt log failed:', error.message);
    });
  if (!alertOwner) return;
  const when = new Date().toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const where = GATE_LABELS[gate] ?? gate;
  void pushToOwners(
    outcome === 'granted' ? 'Admin PIN used' : 'Admin PIN failed',
    `${where}${detail ? ` (${detail})` : ''} — ${when}`,
  );
}
