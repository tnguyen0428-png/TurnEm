// clockLog.ts
//
// Supabase-backed ledger of receptionist clock-in / clock-out events.
// Every CLOCK IN / CLOCK OUT confirmed from the Register's time clock appends
// one row to the `clock_events` table; the Blueprint → Reports → Receptionist
// Hours screen reads them back to render hours worked.
//
// Why Supabase (not localStorage): clock-in/out happens across multiple POS
// devices (front desk, back office, iPad). A per-browser ledger split the
// "in" and "out" of a single shift across devices, producing never-closed
// and orphaned sessions and unreliable payroll totals. The shared table makes
// every device see every event and survives cache clears.
//
// Schema notes:
//   - id is a uuid (DB default) so edits/deletes are idempotent.
//   - timestamp is exposed to the UI as ms epoch; the table stores it as
//     `event_time timestamptz`. Mappers convert between the two.
//   - staffName is denormalized so the report doesn't break if a staff member
//     is renamed or removed later.

import { supabase } from './supabase';

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

interface DbClockEvent {
  id: string;
  staff_id: string;
  staff_name: string;
  type: ClockEventType;
  event_time: string;
  note: string | null;
  edited: boolean | null;
  created_at: string;
}

function fromDb(row: DbClockEvent): ClockEvent {
  return {
    id: row.id,
    staffId: row.staff_id,
    staffName: row.staff_name,
    type: row.type,
    timestamp: new Date(row.event_time).getTime(),
    note: row.note ?? undefined,
    edited: row.edited ?? false,
  };
}

// ── reads ────────────────────────────────────────────────────────────────────

export async function getAllEvents(): Promise<ClockEvent[]> {
  const { data, error } = await supabase
    .from('clock_events')
    .select('*')
    .order('event_time', { ascending: false });
  if (error) { console.error('[clockLog] getAllEvents:', error.message); return []; }
  return (data ?? []).map((r) => fromDb(r as DbClockEvent));
}

// ── writes ───────────────────────────────────────────────────────────────────

export async function appendEvent(
  staffId: string,
  staffName: string,
  type: ClockEventType,
  when: number = Date.now(),
): Promise<ClockEvent | null> {
  const { data, error } = await supabase
    .from('clock_events')
    .insert({
      staff_id: staffId,
      staff_name: staffName,
      type,
      event_time: new Date(when).toISOString(),
    })
    .select('*')
    .single();
  if (error) { console.error('[clockLog] appendEvent:', error.message); return null; }
  return fromDb(data as DbClockEvent);
}

export async function updateEvent(
  id: string,
  patch: Partial<Omit<ClockEvent, 'id'>>,
): Promise<ClockEvent | null> {
  // Build the DB patch from whichever UI fields were provided. Any edit via
  // the report flags the row as edited.
  const dbPatch: Record<string, unknown> = { edited: true };
  if (patch.timestamp !== undefined) dbPatch.event_time = new Date(patch.timestamp).toISOString();
  if (patch.type !== undefined) dbPatch.type = patch.type;
  if (patch.staffId !== undefined) dbPatch.staff_id = patch.staffId;
  if (patch.staffName !== undefined) dbPatch.staff_name = patch.staffName;
  if (patch.note !== undefined) dbPatch.note = patch.note;

  const { data, error } = await supabase
    .from('clock_events')
    .update(dbPatch)
    .eq('id', id)
    .select('*')
    .single();
  if (error) { console.error('[clockLog] updateEvent:', error.message); return null; }
  return fromDb(data as DbClockEvent);
}

export async function deleteEvent(id: string): Promise<boolean> {
  const { error } = await supabase.from('clock_events').delete().eq('id', id);
  if (error) { console.error('[clockLog] deleteEvent:', error.message); return false; }
  return true;
}

/**
 * Group consecutive in/out events for a single staff member into work
 * sessions. An "in" without a following "out" is treated as still on duty
 * (endTime = null). An orphan "out" (no preceding "in") is reported with
 * startTime = null so the user can spot and fix it in the editor.
 *
 * Pure function — operates on an already-fetched event array, unchanged from
 * the original localStorage implementation.
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
