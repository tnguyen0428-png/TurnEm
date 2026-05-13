// clockLog.ts
//
// Local-only ledger of receptionist clock-in / clock-out events, persisted in
// localStorage. Used by the Reports tab in Blueprint to render hours worked.
//
// This is intentionally simple: every CLOCK_IN and CLOCK_OUT triggered from
// the Register's time clock appends one row. Entries can be edited or deleted
// from the report screen (e.g. to correct a forgotten clock-out).
//
// Schema notes:
//   - id is a uuid created at append time so edits/deletes are idempotent.
//   - timestamp is ms epoch in the user's local timezone.
//   - staffName is denormalized so the report doesn't break if a staff member
//     is renamed or removed later.
//   - storage is per-browser (not synced). Upgrade to Supabase later if you
//     need cross-device persistence or payroll-grade durability.

export type ClockEventType = 'in' | 'out';

export interface ClockEvent {
  id: string;
  staffId: string;
  staffName: string;
  type: ClockEventType;
  timestamp: number;            // ms epoch
  /** Free-text note attached to the event (e.g. "fixed forgotten clock-out"). */
  note?: string;
  /** True when the row was created or last modified via the report editor. */
  edited?: boolean;
}

const KEY = 'turnem.clockLog.v1';

function safeParse(raw: string | null): ClockEvent[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (e): e is ClockEvent =>
        e && typeof e.id === 'string' &&
        typeof e.staffId === 'string' &&
        typeof e.staffName === 'string' &&
        (e.type === 'in' || e.type === 'out') &&
        typeof e.timestamp === 'number',
    );
  } catch {
    return [];
  }
}

function write(events: ClockEvent[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(events));
  } catch {
    // Quota exceeded or storage disabled — silently ignore; this is best-effort.
  }
}

export function getAllEvents(): ClockEvent[] {
  if (typeof window === 'undefined') return [];
  return safeParse(localStorage.getItem(KEY));
}

export function appendEvent(
  staffId: string,
  staffName: string,
  type: ClockEventType,
  when: number = Date.now(),
): ClockEvent {
  const ev: ClockEvent = {
    id: crypto.randomUUID(),
    staffId,
    staffName,
    type,
    timestamp: when,
  };
  const all = getAllEvents();
  all.push(ev);
  write(all);
  return ev;
}

export function updateEvent(id: string, patch: Partial<Omit<ClockEvent, 'id'>>): ClockEvent | null {
  const all = getAllEvents();
  const idx = all.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  const merged: ClockEvent = { ...all[idx], ...patch, edited: true };
  all[idx] = merged;
  write(all);
  return merged;
}

export function deleteEvent(id: string): boolean {
  const all = getAllEvents();
  const next = all.filter((e) => e.id !== id);
  if (next.length === all.length) return false;
  write(next);
  return true;
}

/**
 * Group consecutive in/out events for a single staff member into work
 * sessions. An "in" without a following "out" is treated as still on duty
 * (endTime = null). An orphan "out" (no preceding "in") is reported with
 * startTime = null so the user can spot and fix it in the editor.
 */
export interface ClockSession {
  staffId: string;
  staffName: string;
  startEventId: string | null;
  endEventId: string | null;
  startTime: number | null;
  endTime: number | null;
  /** ms; null when still open. */
  durationMs: number | null;
}

export function sessionsFromEvents(events: ClockEvent[]): ClockSession[] {
  // Sort chronological per staff.
  const byStaff = new Map<string, ClockEvent[]>();
  for (const ev of events) {
    if (!byStaff.has(ev.staffId)) byStaff.set(ev.staffId, []);
    byStaff.get(ev.staffId)!.push(ev);
  }
  const sessions: ClockSession[] = [];
  for (const [staffId, list] of byStaff) {
    list.sort((a, b) => a.timestamp - b.timestamp);
    const staffName = list[list.length - 1]?.staffName ?? '';
    let openIn: ClockEvent | null = null;
    for (const ev of list) {
      if (ev.type === 'in') {
        // If we already had an open "in", treat the previous as never-closed.
        if (openIn) {
          sessions.push({
            staffId, staffName,
            startEventId: openIn.id, endEventId: null,
            startTime: openIn.timestamp, endTime: null,
            durationMs: null,
          });
        }
        openIn = ev;
      } else {
        // 'out'
        if (openIn) {
          sessions.push({
            staffId, staffName,
            startEventId: openIn.id, endEventId: ev.id,
            startTime: openIn.timestamp, endTime: ev.timestamp,
            durationMs: Math.max(0, ev.timestamp - openIn.timestamp),
          });
          openIn = null;
        } else {
          // Orphan out — surface it so user can correct.
          sessions.push({
            staffId, staffName,
            startEventId: null, endEventId: ev.id,
            startTime: null, endTime: ev.timestamp,
            durationMs: null,
          });
        }
      }
    }
    if (openIn) {
      sessions.push({
        staffId, staffName,
        startEventId: openIn.id, endEventId: null,
        startTime: openIn.timestamp, endTime: null,
        durationMs: null,
      });
    }
  }
  // Sort all sessions newest-first by either start or end time.
  sessions.sort((a, b) => {
    const aT = a.startTime ?? a.endTime ?? 0;
    const bT = b.startTime ?? b.endTime ?? 0;
    return bT - aT;
  });
  return sessions;
}
