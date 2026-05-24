import type { StaffScheduleEntry, StaffScheduleOverride, StaffTimeOff } from '../types';

// Effective resolved schedule for one (manicurist, date) tuple.
// `null` lunch fields mean "no lunch break configured" (or, when used by
// AppointmentBookView's mid-day block UX, no explicit blocked window).
export interface ResolvedDaySchedule {
  startTime: string;       // HH:MM
  endTime: string;         // HH:MM
  lunchStart: string | null;
  lunchEnd: string | null;
  /** Where the resolved row came from. Useful for UI labels like
   *  "edited for today" vs. "weekly default". */
  source: 'override' | 'blueprint';
}

function weekdayFromDate(ymd: string): number {
  // Parse YYYY-MM-DD as a *local* calendar date (no timezone offset shifting
  // the day). new Date('2026-05-24') would treat it as UTC midnight, which
  // is the previous day in negative-offset zones — splitting parts avoids
  // that pitfall.
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).getDay();
}

function isCoveredByTimeOff(
  manicuristId: string,
  date: string,
  timeOff: StaffTimeOff[],
): boolean {
  return timeOff.some(
    (t) => t.manicuristId === manicuristId && date >= t.startDate && date <= t.endDate,
  );
}

/**
 * Resolve "what hours is X working on date D" with the canonical precedence:
 *   1. StaffTimeOff range covers D     → off (returns null)
 *   2. StaffScheduleOverride for (X,D) → override row (off if working=false)
 *   3. StaffScheduleEntry for weekday  → blueprint hours
 *   4. nothing                         → off (returns null)
 *
 * Callers that need "is X working at all on D?" can null-check the result;
 * callers that need start/end/lunch can read the resolved fields directly.
 */
export function resolveScheduleForDate(
  manicuristId: string,
  date: string,
  schedules: StaffScheduleEntry[],
  overrides: StaffScheduleOverride[],
  timeOff: StaffTimeOff[],
): ResolvedDaySchedule | null {
  if (isCoveredByTimeOff(manicuristId, date, timeOff)) return null;

  const override = overrides.find(
    (o) => o.manicuristId === manicuristId && o.date === date,
  );
  if (override) {
    if (!override.working) return null;
    return {
      startTime: override.startTime,
      endTime: override.endTime,
      lunchStart: override.lunchStart,
      lunchEnd: override.lunchEnd,
      source: 'override',
    };
  }

  const weekday = weekdayFromDate(date);
  const sched = schedules.find(
    (s) => s.manicuristId === manicuristId && s.weekday === weekday,
  );
  if (!sched) return null;
  return {
    startTime: sched.startTime,
    endTime: sched.endTime,
    lunchStart: sched.lunchStart,
    lunchEnd: sched.lunchEnd,
    source: 'blueprint',
  };
}

/** True iff resolveScheduleForDate returns non-null. */
export function isWorkingOnDate(
  manicuristId: string,
  date: string,
  schedules: StaffScheduleEntry[],
  overrides: StaffScheduleOverride[],
  timeOff: StaffTimeOff[],
): boolean {
  return resolveScheduleForDate(manicuristId, date, schedules, overrides, timeOff) !== null;
}
