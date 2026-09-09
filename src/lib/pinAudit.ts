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
const GATE_ACTIONS: Record<string, { did: string; tried: string }> = {
  'register:closed-shift': {
    did: 'opened a closed shift',
    tried: 'tried to open a closed shift',
  },
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
  /** Whose code it was, whenever the entered PIN is one we can put a name to —
   *  a receptionist's own code, granted or refused. Absent means the code
   *  matched nothing personal: the master PIN (grant) or an unrecognized code
   *  (refusal). Keeps the alert honest either way; "Admin PIN used" for a staff
   *  code would send Tony looking for an admin who was never there, and
   *  "someone tried" for a code we could name is the thing he can't act on. */
  actor?: string,
) {
  // The name goes into `detail` too — the log table has no actor column, and a
  // row that can't say who is half a record.
  const loggedDetail = [detail, actor].filter(Boolean).join(' · ') || null;
  void supabase
    .from('admin_pin_attempt_log')
    .insert({ gate, detail: loggedDetail, outcome })
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
  if (action) {
    const at = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    // Who, as precisely as the entered code allows. A personal code names the
    // person on both outcomes. The master PIN identifies nobody who holds it,
    // so a grant is "Admin"; a refusal matched nothing at all, so it is
    // "Someone" — and the body says the code itself was unrecognized, which is
    // the difference between a wrong keypress and a stranger guessing.
    const who = actor ?? (outcome === 'granted' ? 'Admin' : 'Someone');
    const tail = [detail, when].filter(Boolean).join(' — ');
    void pushToOwners(
      `${who} ${outcome === 'granted' ? action.did : action.tried} at ${at}`,
      outcome === 'granted' || actor ? tail : `Unrecognized code — ${tail}`,
    );
    return;
  }

  const who = actor ? `${actor}'s PIN` : 'Admin PIN';
  void pushToOwners(
    outcome === 'granted' ? `${who} used` : `${who} failed`,
    `${where}${detail ? ` (${detail})` : ''} — ${when}`,
  );
}
