// Current time-of-day in Los Angeles, in minutes since midnight. Used to
// spot a check-in against a scheduled time that's already well past —
// e.g. clicking "Check In" on an unprocessed 8 AM appointment at 1 PM,
// which silently attaches a same-named client's later, unrelated visit
// onto that stale record instead of a fresh one (Lisa Kiel, 2026-08-06).
export function getNowMinutesLA(at: number = Date.now()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(at));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  // Intl can render midnight as "24" in some locales/runtimes; fold it to 0 so
  // the small hours don't read as the end of the day.
  return (h % 24) * 60 + m;
}

// ── "Almost done" window ───────────────────────────────────────────────────
//
// How close to finishing a busy tech must be to count as almost-done. It is
// wider late in the day (Tony 2026-08-31): at the end of a shift you want the
// next client lined up rather than left waiting for someone to actually free
// up.
//
// CHANGE THE CUTOFF OR THE WINDOWS HERE — these three constants are the whole
// rule, and both places that care read them.
//
// This is not only cosmetic. The same window decides who appears in the assign
// list: a busy tech inside it is offered alongside genuinely available ones. So
// after the cutoff, late walk-ins start being routed to techs who are still
// working five minutes sooner than they were before.
export const ALMOST_DONE_CUTOFF_HOUR_LA = 16;                 // 4 PM LA
export const ALMOST_DONE_WINDOW_MS = 10 * 60 * 1000;          // before the cutoff
export const ALMOST_DONE_WINDOW_LATE_MS = 15 * 60 * 1000;     // at or after it

/** The almost-done window in force at `at` (defaults to now), LA time. */
export function getAlmostDoneWindowMs(at: number = Date.now()): number {
  return getNowMinutesLA(at) >= ALMOST_DONE_CUTOFF_HOUR_LA * 60
    ? ALMOST_DONE_WINDOW_LATE_MS
    : ALMOST_DONE_WINDOW_MS;
}

export function getTodayLA(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === 'year')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  return `${year}-${month}-${day}`;
}

export function getLocalDateStr(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((p) => p.type === 'year')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  return `${year}-${month}-${day}`;
}

// "Business day" = the operating day for the salon. As of 2026-05-22 this
// is the calendar day in LA (rollover at midnight). The earlier design
// shifted back 9 hours so late-night close-out work still counted under the
// day the work was performed, but that confused testing/operations done
// between midnight and 9 AM (services appeared under "yesterday"). Now the
// business day matches the wall-clock LA calendar.
export function getBusinessDayLA(date: Date = new Date()): string {
  return getLocalDateStr(date);
}

export function formatWaitTime(arrivedAt: number): string {
  const diff = Date.now() - arrivedAt;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins === 1) return '1 min';
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hrs}h ${remainMins}m`;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/** Format an "HH:MM" 24-hour string into a 12-hour display string (e.g. "14:30" -> "2:30 PM"). */
export function formatTimeOfDay(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
}