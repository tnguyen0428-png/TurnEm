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
 * Sentence form of a granted unlock — the push reads "<who> <action> at <time>"
 * ("Panda 2 opened a closed shift at 6:31 PM"), which is what Tony wants to see
 * on his phone: an event, not a PIN-audit line (2026-09-09).
 *
 * Only gates listed here take that shape; the rest keep the older
 * "<who>'s PIN used — <label>" wording, so adding a phrase is an opt-in per
 * gate rather than a silent rewrite of every existing alert.
 */
const GATE_ACTIONS: Record<string, string> = {
  'register:closed-shift': 'opened a closed shift',
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
  /** Who unlocked it, when the gate was opened with something other than the
   *  master PIN (e.g. a receptionist's own code on a same-day closed shift).
   *  Keeps the push honest — "Admin PIN used" for a staff code would send Tony
   *  looking for an admin who was never there. */
  actor?: string,
) {
  void supabase
    .from('admin_pin_attempt_log')
    .insert({ gate, detail: detail ?? null, outcome })
    .then(({ error }) => {
      if (error) console.warn('[pin] attempt log failed:', error.message);
    });
  if (!alertOwner) return;
  const now = new Date();
  const when = now.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const where = GATE_LABELS[gate] ?? gate;

  const action = GATE_ACTIONS[gate];
  if (outcome === 'granted' && action) {
    // Named when a personal code was used; the master PIN says nothing about
    // who is holding it, so it stays "Admin" rather than guessing at a name.
    const at = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    void pushToOwners(
      `${actor ?? 'Admin'} ${action} at ${at}`,
      detail ? `${detail} — ${when}` : when,
    );
    return;
  }

  const who = actor ? `${actor}'s PIN` : 'Admin PIN';
  void pushToOwners(
    outcome === 'granted' ? `${who} used` : `${who} failed`,
    `${where}${detail ? ` (${detail})` : ''} — ${when}`,
  );
}
