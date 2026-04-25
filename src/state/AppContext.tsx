import { createContext, useContext, useReducer, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import type { AppState, Manicurist, QueueEntry, ServiceRequest, ServiceType, Appointment, SalonService, TurnCriteria, CalendarDay, DailyHistory, CompletedEntry } from '../types';
import type { AppAction } from './actions';
import { appReducer, INITIAL_STATE } from './reducer';
import { supabase } from '../lib/supabase';
import { defaultSalonServices } from '../constants/salonServices';
import { defaultManicurists } from '../constants/manicurists';
import { getLocalDateStr, getTodayLA } from '../utils/time';

// Visible save status. Driven by a counter of in-flight DB writes:
// - 'saving': at least one upsert/delete is awaiting a response
// - 'saved': all in-flight writes resolved successfully (auto-fades to 'idle' after ~1.5s)
// - 'error': a write failed; cleared by the next successful save
// - 'idle': nothing to show
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface AppContextType {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  saveTodayHistory: (dateOverride?: string) => Promise<boolean>;
  archiveTodayIfNeeded: (skipHourCheck?: boolean) => Promise<void>;
  syncError: string | null;
  clearSyncError: () => void;
  saveStatus: SaveStatus;
}

const AppContext = createContext<AppContextType | null>(null);


function mapDbManicurist(row: Record<string, unknown>): Manicurist {
  return {
    id: row.id as string,
    name: row.name as string,
    color: row.color as string,
    phone: (row.phone as string) || '',
    skills: (row.skills as string[]) || [],
    clockedIn: row.clocked_in as boolean,
    clockInTime: row.clock_in_time ? new Date(row.clock_in_time as string).getTime() : null,
    totalTurns: Number(row.total_turns) || 0,
    currentClient: (row.current_client_id as string) || null,
    status: (row.status as Manicurist['status']) || 'available',
    hasFourthPositionSpecial: (row.has_fourth_position_special as boolean) || false,
    hasCheck2: (row.has_check2 as boolean) || false,
    hasCheck3: (row.has_check3 as boolean) || false,
    hasWax: (row.has_wax as boolean) || false,
    hasWax2: (row.has_wax2 as boolean) || false,
    hasWax3: (row.has_wax3 as boolean) || false,
    timeAdjustments: (row.time_adjustments as Record<string, number>) || {},
    pinCode: (row.pin_code as string) || '',
    breakStartTime: row.break_start_time ? Number(row.break_start_time) : null,
    smsOptIn: (row.sms_opt_in as boolean) || false,
    showInBook: row.show_in_book === false ? false : true,
    isReceptionist: (row.is_receptionist as boolean) || false,
  };
}

function mapDbServiceRequest(r: Record<string, unknown>): ServiceRequest {
  if (Array.isArray(r.manicuristIds)) {
    return { service: r.service as ServiceType, manicuristIds: r.manicuristIds as string[] };
  }
  const legacy = r.manicuristId as string | null;
  return { service: r.service as ServiceType, manicuristIds: legacy ? [legacy] : [] };
}

function mapDbQueueEntry(row: Record<string, unknown>): QueueEntry {
  const dbServices = row.services as string[] | null;
  const fallback = row.service as string;
  const rawRequests = row.service_requests as Array<Record<string, unknown>> | null;
  const serviceRequests: ServiceRequest[] = Array.isArray(rawRequests)
    ? rawRequests.map(mapDbServiceRequest)
    : [];
  return {
    id: row.id as string,
    clientName: row.client_name as string,
    services: (dbServices && dbServices.length > 0 ? dbServices : [fallback]).filter(Boolean) as ServiceType[],
    turnValue: Number(row.turn_value) || 0,
    serviceRequests,
    requestedManicuristId: (row.requested_manicurist_id as string) || null,
    isRequested: row.is_requested as boolean,
    isAppointment: (row.is_appointment as boolean) || false,
    assignedManicuristId: (row.assigned_manicurist_id as string) || null,
    status: (row.status as QueueEntry['status']) || 'waiting',
    arrivedAt: new Date(row.arrived_at as string).getTime(),
    startedAt: row.started_at ? new Date(row.started_at as string).getTime() : null,
    completedAt: row.completed_at ? new Date(row.completed_at as string).getTime() : null,
    extraTimeMs: Number(row.extra_time_ms) || 0,
  };
}

// Used by the realtime subscription on completed_services. The initial-load path has its own
// inline mapper with extra "bad pattern" cleanup — that cleanup is only relevant for historic
// rows and doesn't belong in a realtime event handler.
function mapDbCompleted(row: Record<string, unknown>): CompletedEntry {
  const dbSvcs = row.services as string[] | null;
  const fallbackSvc = row.service as string;
  const services = (dbSvcs && dbSvcs.length > 0 ? dbSvcs : [fallbackSvc]).filter(Boolean) as ServiceType[];
  const rawRequested = Array.isArray(row.requested_services) ? (row.requested_services as string[]) : [];
  return {
    id: row.id as string,
    clientName: row.client_name as string,
    services,
    turnValue: Number(row.turn_value) || 0,
    manicuristId: row.manicurist_id as string,
    manicuristName: row.manicurist_name as string,
    manicuristColor: row.manicurist_color as string,
    startedAt: new Date(row.started_at as string).getTime(),
    completedAt: new Date(row.completed_at as string).getTime(),
    requestedServices: rawRequested.length > 0 ? rawRequested as ServiceType[] : undefined,
    isAppointment: (row.is_appointment as boolean) || false,
    isRequested: (row.is_requested as boolean) || false,
  };
}

function mapDbAppointment(row: Record<string, unknown>): Appointment {
  const legacyService = (row.service as string) || '';
  const dbServices = row.services as ServiceType[] | null;
  const services = dbServices && dbServices.length > 0 ? dbServices : (legacyService ? [legacyService as ServiceType] : []);
  const serviceRequests = (row.service_requests as ServiceRequest[]) || [];
  // Derive legacy manicuristId from first service request if available
  const firstReq = serviceRequests[0];
  const manicuristId = (row.manicurist_id as string) || (firstReq?.manicuristIds?.[0] ?? null);
  return {
    id: row.id as string,
    clientName: (row.client_name as string) || '',
    clientPhone: (row.client_phone as string) || '',
    service: services[0] || legacyService as ServiceType,
    services,
    serviceRequests,
    manicuristId,
    date: row.date as string,
    time: row.time as string,
    notes: (row.notes as string) || '',
    status: (row.status as Appointment['status']) || 'scheduled',
    createdAt: row.created_at ? new Date(row.created_at as string).getTime() : Date.now(),
  };
}

function mapDbSalonService(row: Record<string, unknown>): SalonService {
  return {
    id: row.id as string,
    name: row.name as string,
    turnValue: Number(row.turn_value) || 0,
    duration: Number(row.duration),
    price: Number(row.price),
    isActive: row.is_active as boolean,
    category: (row.category as string) || '',
    sortOrder: Number(row.sort_order) || 0,
    isFourthPositionSpecial: (row.is_fourth_position_special as boolean) || false,
  };
}

function mapDbTurnCriteria(row: Record<string, unknown>): TurnCriteria {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) || '',
    priority: Number(row.priority),
    enabled: row.enabled as boolean,
    type: (row.type as TurnCriteria['type']) || 'sort',
    value: Number(row.value),
  };
}

function mapDbCalendarDay(row: Record<string, unknown>): CalendarDay {
  return {
    date: row.date as string,
    status: (row.status as CalendarDay['status']) || 'open',
    note: (row.note as string) || '',
  };
}


// Module-level guard: prevents loadInitialData from running more than once per page load,
// even if Vite Fast Refresh re-mounts the component during development.
let _dataLoadStarted = false;

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, INITIAL_STATE);
  const [syncError, setSyncError] = useState<string | null>(null);
  const clearSyncError = useCallback(() => {
    setSyncError(null);
    setSaveStatus((current) => (current === 'error' ? 'idle' : current));
  }, []);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  // Counter of currently in-flight sync operations. When this drops back to zero with
  // no error, status flips to 'saved' and auto-fades. On error, status flips to 'error'.
  const pendingSavesRef = useRef(0);
  const savedFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevStateRef = useRef<AppState>(INITIAL_STATE);
  const completedRef = useRef<AppState['completed']>(INITIAL_STATE.completed);
  const dailyHistoryRef = useRef<AppState['dailyHistory']>(INITIAL_STATE.dailyHistory);

  // Wraps a sync function so we track in-flight count and surface 'saving' / 'saved' /
  // 'error' to the UI. Each call increments the counter and shows 'saving'; when the
  // last in-flight resolves we either flip to 'saved' (auto-fade) or 'error'.
  const trackSave = useCallback(async (fn: () => Promise<void>) => {
    pendingSavesRef.current += 1;
    setSaveStatus('saving');
    if (savedFadeTimerRef.current) {
      clearTimeout(savedFadeTimerRef.current);
      savedFadeTimerRef.current = null;
    }
    let failed = false;
    try {
      await fn();
    } catch (err) {
      failed = true;
      console.error('[trackSave] uncaught error:', err);
    } finally {
      pendingSavesRef.current = Math.max(0, pendingSavesRef.current - 1);
      if (pendingSavesRef.current === 0) {
        if (failed) {
          setSaveStatus('error');
        } else {
          // The sync function reports its own errors via setSyncError. If syncError is
          // already set we surface 'error'; otherwise show a brief 'saved' confirmation.
          setSaveStatus((current) => (current === 'error' ? 'error' : 'saved'));
          savedFadeTimerRef.current = setTimeout(() => {
            setSaveStatus((current) => (current === 'saved' ? 'idle' : current));
          }, 1500);
        }
      }
    }
  }, []);

  // When setSyncError is called by a sync function, also surface 'error' status so the
  // banner+toast pair stay consistent. Wrap the setter so callers don't need to know.
  const setSyncErrorTracked = useCallback((msg: string | null) => {
    setSyncError(msg);
    if (msg) setSaveStatus('error');
  }, []);
  // When a REMOTE_* action is about to be dispatched, the subscription handler sets this
  // to true so the sync effect below skips its DB flush for that state transition.
  // This prevents echo loops: Device A writes → subscription fires on A → dispatch REMOTE_*
  // → flag=true → sync effect skips so A doesn't re-upsert its own change. Same logic
  // prevents Device B from writing back a row it just received from the subscription.
  const isApplyingRemoteRef = useRef(false);

  // Tombstone map: when we delete an appt locally, we remember its id for ~10 seconds.
  // The race we're protecting against: a stale UPDATE event for that appt may already be
  // in flight from a prior write. When it arrives AFTER the local DELETE, the reducer's
  // "if idx === -1, add as new" branch resurrects the row. With a tombstone, the realtime
  // handler refuses to dispatch REMOTE_APPOINTMENT_UPSERT for IDs we just nuked.
  const apptTombstonesRef = useRef<Map<string, number>>(new Map());
  const TOMBSTONE_MS = 10000;
  function tombstone(id: string) {
    apptTombstonesRef.current.set(id, Date.now());
    // Sweep old entries
    const cutoff = Date.now() - TOMBSTONE_MS;
    for (const [k, ts] of apptTombstonesRef.current) {
      if (ts < cutoff) apptTombstonesRef.current.delete(k);
    }
  }
  function isTombstoned(id: string): boolean {
    const ts = apptTombstonesRef.current.get(id);
    if (!ts) return false;
    if (Date.now() - ts > TOMBSTONE_MS) {
      apptTombstonesRef.current.delete(id);
      return false;
    }
    return true;
  }

  useEffect(() => {
    if (!_dataLoadStarted) {
      _dataLoadStarted = true;
      loadInitialData();
    }
  }, []);

  async function loadInitialData() {
    const [
      { data: staffRows, error: staffError },
      { data: queueRows },
      { data: completedRows },
      { data: appointmentRows },
      { data: serviceRows, error: serviceError },
      { data: criteriaRows },
      { data: calendarRows },
      { data: dailyHistoryRows },
    ] = await Promise.all([
      supabase.from('manicurists').select('*').order('sort_order', { ascending: true }),
      supabase.from('queue_entries').select('*'),
      supabase.from('completed_services').select('*'),
      supabase.from('appointments').select('*'),
      supabase.from('salon_services').select('*').order('sort_order'),
      supabase.from('turn_criteria').select('*'),
      supabase.from('calendar_days').select('*'),
      supabase.from('daily_history').select('*').order('date', { ascending: false }),
    ]);

    const appointments = (appointmentRows || []).map(mapDbAppointment);
    // Only seed defaults when the query itself succeeded and genuinely returned nothing.
    // If serviceError is set it means the DB call failed â we must not overwrite with defaults.
    if (!serviceError && (!serviceRows || serviceRows.length === 0)) {
      for (const s of defaultSalonServices) {
        const { error } = await supabase.from('salon_services').upsert({
          id: s.id,
          name: s.name,
          category: s.category,
          price: s.price,
          sort_order: s.sortOrder,
          turn_value: s.turnValue,
          duration: s.duration,
          is_active: s.isActive,
          is_fourth_position_special: s.isFourthPositionSpecial,
        }, { onConflict: 'id' });
        if (error) console.error('[loadInitialData] salon_services seed error:', error);
      }
    }
    const salonServices = (serviceRows && serviceRows.length > 0)
      ? serviceRows.map(mapDbSalonService)
      : defaultSalonServices;
    const turnCriteria = (criteriaRows || []).map(mapDbTurnCriteria);
    const calendarDays = (calendarRows || []).map(mapDbCalendarDay);
    const dailyHistory: DailyHistory[] = (dailyHistoryRows || []).map((row: Record<string, unknown>) => ({
      id: row.id as string,
      date: row.date as string,
      entries: (row.entries as CompletedEntry[]) || [],
    }));

    let manicurists = (staffRows || []).map(mapDbManicurist);
    // Guard: only seed default manicurists when the query succeeded with zero rows.
    // A staffError means the DB call failed â seeding here would replace real data with defaults.
    if (!staffError && manicurists.length === 0) {
      for (const m of defaultManicurists) {
        const { error } = await supabase.from('manicurists').insert({
          id: m.id,
          name: m.name,
          color: m.color,
          phone: m.phone,
          skills: m.skills,
          clocked_in: m.clockedIn,
          clock_in_time: m.clockInTime ? new Date(m.clockInTime).toISOString() : null,
          total_turns: m.totalTurns,
          current_client_id: m.currentClient,
          status: m.status,
          has_fourth_position_special: m.hasFourthPositionSpecial,
          has_check2: m.hasCheck2,
          has_check3: m.hasCheck3,
          has_wax: m.hasWax,
          has_wax2: m.hasWax2,
          has_wax3: m.hasWax3,
          time_adjustments: m.timeAdjustments || {},
          pin_code: m.pinCode || null,
          break_start_time: m.breakStartTime ?? null,
          sms_opt_in: m.smsOptIn || false,
        });
        if (error) console.error('[loadInitialData] manicurists seed error:', error);
      }
      manicurists = defaultManicurists;
    }
    const queue = (queueRows || []).map(mapDbQueueEntry);
    const completed = (completedRows || []).map((row: Record<string, unknown>) => {
      const dbSvcs = row.services as string[] | null;
      const fallbackSvc = row.service as string;
      const services = (dbSvcs && dbSvcs.length > 0 ? dbSvcs : [fallbackSvc]).filter(Boolean) as ServiceType[];
      const rawRequested = Array.isArray(row.requested_services) ? (row.requested_services as string[]) : [];

      // Cleanup: a bug caused ALL services on multi-service split entries to get synthetic
      // requested_services (even when the client never requested anyone). Detect and clear:
      // bad pattern = every service in the entry is also in requestedServices (all marked requested)
      // AND there are 2+ services (single-service genuine requests are safe to keep).
      const reqSet = new Set(rawRequested);
      const isBadPattern = services.length > 1
        && rawRequested.length > 0
        && services.every((s) => reqSet.has(s as string));

      return {
        id: row.id as string,
        clientName: row.client_name as string,
        services,
        turnValue: Number(row.turn_value) || 0,
        manicuristId: row.manicurist_id as string,
        manicuristName: row.manicurist_name as string,
        manicuristColor: row.manicurist_color as string,
        startedAt: new Date(row.started_at as string).getTime(),
        completedAt: new Date(row.completed_at as string).getTime(),
        requestedServices: isBadPattern ? undefined : (rawRequested.length > 0 ? rawRequested as ServiceType[] : undefined),
        isAppointment: (row.is_appointment as boolean) || false,
        isRequested: (row.is_requested as boolean) || false,
      };
    });

    // Persist the cleanup to DB for any bad entries we found above
    for (const e of completed) {
      const rawRow = (completedRows || []).find((r: Record<string, unknown>) => r.id === e.id);
      const rawRequested = Array.isArray(rawRow?.requested_services) ? rawRow.requested_services as string[] : [];
      if (rawRequested.length > 0 && e.requestedServices === undefined) {
        // This entry had bad data â clear it in the DB too
        const { error: cleanupError } = await supabase.from('completed_services').update({ requested_services: [] }).eq('id', e.id);
        if (cleanupError) console.error('[loadInitialData] cleanup error:', cleanupError);
      }
    }

    // Also clean daily_history entries with the same bad pattern
    const cleanedHistory = dailyHistory.map((day) => ({
      ...day,
      entries: day.entries.map((e) => {
        const rawReq = Array.isArray(e.requestedServices) ? (e.requestedServices as string[]) : [];
        if (rawReq.length === 0 || e.services.length <= 1) return e;
        const reqSet2 = new Set(rawReq);
        const isBad = (e.services as string[]).every((s) => reqSet2.has(s));
        return isBad ? { ...e, requestedServices: undefined } : e;
      }),
    }));
    for (const day of cleanedHistory) {
      const orig = dailyHistory.find((d) => d.id === day.id);
      const changed = orig && JSON.stringify(orig.entries) !== JSON.stringify(day.entries);
      if (changed) {
        const { error: cleanupError } = await supabase.from('daily_history').update({ entries: day.entries }).eq('id', day.id);
        if (cleanupError) console.error('[loadInitialData] cleanup error:', cleanupError);
      }
    }

    dispatch({ type: 'LOAD_STATE', state: { manicurists, queue, completed, appointments, salonServices, turnCriteria, calendarDays, dailyHistory: cleanedHistory } });

    // Startup stale-data check: two conditions trigger an archive+reset on load:
    // 1. system_state.last_archive_date is behind today â the 11:59pm timer missed (app closed,
    //    or stale closure bug prevented it from firing). Archive any missed day's data now.
    // 2. Stale completed/queue entries exist with dates before today â belt-and-suspenders catch.
    const today = getTodayLA();
    const { data: sysStateRow } = await supabase.from('system_state').select('last_archive_date').eq('id', 'singleton').single();
    const lastArchiveDate = (sysStateRow as Record<string,unknown> | null)?.last_archive_date as string | null;
    if (lastArchiveDate && lastArchiveDate < today) {
      console.log('[startup] missed reset detected â system_state.last_archive_date=', lastArchiveDate, 'today=', today);
    }
    const staleCompleted = completed.filter(c => getLocalDateStr(new Date(c.completedAt)) < today);
    const staleQueue = queue.filter(c => getLocalDateStr(new Date(c.arrivedAt)) < today);

    if (staleCompleted.length > 0 || staleQueue.length > 0) {
      console.log('[startup] stale data detected from previous day â archiving and resetting', { staleCompleted: staleCompleted.length, staleQueue: staleQueue.length });

      // Archive stale completed entries grouped by date, update in-memory state too
      const byDate = new Map<string, typeof completed>();
      for (const c of staleCompleted) {
        const d = getLocalDateStr(new Date(c.completedAt));
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d)!.push(c);
      }
      const updatedHistory = [...dailyHistory];
      for (const [date, entries] of byDate) {
        const existingIdx = updatedHistory.findIndex(h => h.date === date);
        const existing = existingIdx >= 0 ? updatedHistory[existingIdx] : null;
        const mergedEntries = existing ? [...existing.entries, ...entries] : entries;
        const historyEntry: DailyHistory = {
          id: existing?.id ?? crypto.randomUUID(),
          date,
          entries: mergedEntries,
        };
        const { error: histErr } = await supabase.from('daily_history').upsert(
          { id: historyEntry.id, date: historyEntry.date, entries: historyEntry.entries },
          { onConflict: 'date' }
        );
        if (histErr) { console.error('[startup] daily_history upsert error:', histErr); setSyncError('Failed to archive history â data may not be saved. Check connection.'); }
        // Update in-memory history so the history screen can find it immediately
        dispatch({ type: 'SAVE_DAILY_HISTORY', entry: historyEntry });
      }

      // Clear stale queue entries and completed services from DB
      for (const c of staleQueue) {
        await supabase.from('queue_entries').delete().eq('id', c.id);
      }
      if (staleCompleted.length > 0) {
        // Delete only the specific stale IDs â never use neq() here as it would wipe the whole table
        const staleIds = staleCompleted.map(c => c.id);
        const { error: deleteErr } = await supabase.from('completed_services').delete().in('id', staleIds);
        if (deleteErr) console.error('[startup] failed to delete stale completed_services:', deleteErr);
      }

      dispatch({ type: 'DAILY_RESET' });

      // Update system_state so future startups know the reset ran
      const { error: ssErr } = await supabase
        .from('system_state')
        .upsert({ id: 'singleton', last_archive_date: today, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      if (ssErr) console.error('[startup] failed to update system_state:', ssErr);
      else console.log('[startup] system_state updated to', today);
    } else if (lastArchiveDate && lastArchiveDate < today) {
      // system_state is stale but no stale entries found in DB â the reset DID clear the DB
      // but system_state was never updated. Fix the date so future startups dont re-run.
      await supabase
        .from('system_state')
        .upsert({ id: 'singleton', last_archive_date: today, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      console.log('[startup] system_state was stale with no stale data â updated to', today);
    }
  }

  const saveTodayHistory = useCallback(async (dateOverride?: string): Promise<boolean> => {
    const completed = completedRef.current;
    if (completed.length === 0) return true; // nothing to save â not an error
    const date = dateOverride ?? getTodayLA();
    // Reuse the existing entry's ID for this date so repeated saves don't generate a new
    // UUID each time (which would fight the onConflict 'date' upsert and change the stored id).
    const existingEntry = dailyHistoryRef.current.find(h => h.date === date);
    const entry: DailyHistory = {
      id: existingEntry?.id ?? crypto.randomUUID(),
      date,
      entries: completed,
    };
    const { error } = await supabase
      .from('daily_history')
      .upsert({ id: entry.id, date: entry.date, entries: entry.entries }, { onConflict: 'date' });
    if (error) {
      console.error('[saveTodayHistory] upsert error:', error);
      setSyncError('Failed to save history â data may not be saved. Check connection.');
      return false; // caller must NOT dispatch or reset on failure
    }
    dispatch({ type: 'SAVE_DAILY_HISTORY', entry });
    return true;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Intentionally empty â reads completedRef/dailyHistoryRef, never stale state

  const archiveTodayIfNeeded = useCallback(async (skipHourCheck = false) => {
    const now = new Date();
    const laHour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        hour: '2-digit',
        hour12: false,
      }).format(now)
    );
    // The hour check is bypassed when called from startup (skipHourCheck=true),
    // since a missed reset from a previous day should always run regardless of current time.
    if (!skipHourCheck && (laHour < 23 || laHour >= 24)) {
      console.error('[archiveTodayIfNeeded] aborted â not within rollover window', { laHour });
      return;
    }
    const saved = await saveTodayHistory();
    if (!saved) {
      // Save failed â do NOT reset. Keeping today's data in memory is safer than
      // wiping it. The scheduler will retry on the next tick.
      console.error('[archiveTodayIfNeeded] save failed â skipping DAILY_RESET to prevent data loss');
      return;
    }
    dispatch({ type: 'DAILY_RESET' });
    // Write today's date to system_state so the startup check knows the reset ran.
    const archiveDate = getTodayLA();
    const { error: ssError } = await supabase
      .from('system_state')
      .upsert({ id: 'singleton', last_archive_date: archiveDate, updated_at: new Date().toISOString() }, { onConflict: 'id' });
    if (ssError) console.error('[archiveTodayIfNeeded] failed to update system_state:', ssError);
    else console.log('[archiveTodayIfNeeded] reset complete, system_state updated to', archiveDate);
  }, [saveTodayHistory]);

  const isStaffMode = typeof window !== 'undefined' && (
    new URLSearchParams(window.location.search).get('mode') === 'staff' ||
    (window as any).__TURNEM_STAFF_MODE__ === true
  );

  useEffect(() => {
    if (!state.loaded) return;
    // Snapshot-and-clear the remote flag up front so every early-return path clears it too.
    const wasRemote = isApplyingRemoteRef.current;
    isApplyingRemoteRef.current = false;
    // Staff mode is read-onlyâ never sync back to DB
    if (isStaffMode) {
      prevStateRef.current = state;
      completedRef.current = state.completed;
      dailyHistoryRef.current = state.dailyHistory;
      return;
    }
    // This state change came from a realtime subscription. Skip the flush so we don't
    // echo the remote change back to the DB (which would re-broadcast and loop).
    if (wasRemote) {
      prevStateRef.current = state;
      completedRef.current = state.completed;
      dailyHistoryRef.current = state.dailyHistory;
      return;
    }
    const prev = prevStateRef.current;
    // On the very first render after loadInitialData dispatches LOAD_STATE, prev still holds
    // INITIAL_STATE (all empty arrays). Syncing here would push empty state back to the DB
    // and race with the just-completed fetch. Skip this first run and just advance the ref.
    if (!prev.loaded) {
      prevStateRef.current = state;
      return;
    }
    if (prev.manicurists !== state.manicurists) trackSave(() => syncManicurists(state.manicurists, prev.manicurists, setSyncErrorTracked));
    if (prev.queue !== state.queue) trackSave(() => syncQueue(state.queue, prev.queue, setSyncErrorTracked));
    if (prev.completed !== state.completed) trackSave(() => syncCompleted(state.completed, prev.completed, setSyncErrorTracked));
    if (prev.appointments !== state.appointments) {
      // Detect local deletions and tombstone their IDs so a stale realtime UPSERT can't resurrect them
      const currentApptIds = new Set(state.appointments.map((a) => a.id));
      for (const a of prev.appointments) {
        if (!currentApptIds.has(a.id)) tombstone(a.id);
      }
      trackSave(() => syncAppointments(state.appointments, prev.appointments, setSyncErrorTracked));
    }
    if (prev.salonServices !== state.salonServices) trackSave(() => syncSalonServices(state.salonServices, prev.salonServices, setSyncErrorTracked));
    if (prev.turnCriteria !== state.turnCriteria) trackSave(() => syncTurnCriteria(state.turnCriteria, prev.turnCriteria, setSyncErrorTracked));
    if (prev.calendarDays !== state.calendarDays) trackSave(() => syncCalendarDays(state.calendarDays, prev.calendarDays, setSyncErrorTracked));
    if (prev.dailyHistory !== state.dailyHistory) trackSave(() => syncDailyHistory(state.dailyHistory, prev.dailyHistory, setSyncErrorTracked));
    prevStateRef.current = state;
    completedRef.current = state.completed;
    dailyHistoryRef.current = state.dailyHistory;
  }, [state]);

  // Realtime multi-device sync. Subscribes to postgres_changes on the five live-ops tables
  // after the initial data load. Each INSERT/UPDATE/DELETE from another device (or an echo
  // of our own write) becomes a REMOTE_* action. The sync effect above checks isApplyingRemoteRef
  // and skips the DB flush for any state change caused by these actions, preventing echo loops.
  useEffect(() => {
    if (!state.loaded) return;

    const manicuristsChan = supabase
      .channel('realtime:manicurists')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'manicurists' }, (payload) => {
        isApplyingRemoteRef.current = true;
        if (payload.eventType === 'DELETE') {
          const id = (payload.old as { id?: string } | null)?.id;
          if (id) dispatch({ type: 'REMOTE_MANICURIST_DELETE', id });
          else isApplyingRemoteRef.current = false; // nothing dispatched, clear flag
        } else {
          dispatch({ type: 'REMOTE_MANICURIST_UPSERT', manicurist: mapDbManicurist(payload.new as Record<string, unknown>) });
        }
      })
      .subscribe();

    const queueChan = supabase
      .channel('realtime:queue_entries')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'queue_entries' }, (payload) => {
        isApplyingRemoteRef.current = true;
        if (payload.eventType === 'DELETE') {
          const id = (payload.old as { id?: string } | null)?.id;
          if (id) dispatch({ type: 'REMOTE_QUEUE_DELETE', id });
          else isApplyingRemoteRef.current = false;
        } else {
          dispatch({ type: 'REMOTE_QUEUE_UPSERT', entry: mapDbQueueEntry(payload.new as Record<string, unknown>) });
        }
      })
      .subscribe();

    const completedChan = supabase
      .channel('realtime:completed_services')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'completed_services' }, (payload) => {
        isApplyingRemoteRef.current = true;
        if (payload.eventType === 'DELETE') {
          const id = (payload.old as { id?: string } | null)?.id;
          if (id) dispatch({ type: 'REMOTE_COMPLETED_DELETE', id });
          else isApplyingRemoteRef.current = false;
        } else {
          dispatch({ type: 'REMOTE_COMPLETED_UPSERT', entry: mapDbCompleted(payload.new as Record<string, unknown>) });
        }
      })
      .subscribe();

    const appointmentsChan = supabase
      .channel('realtime:appointments')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'appointments' }, (payload) => {
        if (payload.eventType === 'DELETE') {
          const id = (payload.old as { id?: string } | null)?.id;
          if (id) {
            tombstone(id); // remember it so any stale UPDATE that arrives later is ignored
            isApplyingRemoteRef.current = true;
            dispatch({ type: 'REMOTE_APPOINTMENT_DELETE', id });
          }
        } else {
          const row = mapDbAppointment(payload.new as Record<string, unknown>);
          // Reject resurrections: if we just deleted this id locally (or saw a remote DELETE),
          // ignore any stale UPSERT that's still in flight.
          if (isTombstoned(row.id)) return; // stale UPSERT for an id we just deleted — ignore
          isApplyingRemoteRef.current = true;
          dispatch({ type: 'REMOTE_APPOINTMENT_UPSERT', appointment: row });
        }
      })
      .subscribe();

    const salonServicesChan = supabase
      .channel('realtime:salon_services')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'salon_services' }, (payload) => {
        isApplyingRemoteRef.current = true;
        if (payload.eventType === 'DELETE') {
          const id = (payload.old as { id?: string } | null)?.id;
          if (id) dispatch({ type: 'REMOTE_SALON_SERVICE_DELETE', id });
          else isApplyingRemoteRef.current = false;
        } else {
          dispatch({ type: 'REMOTE_SALON_SERVICE_UPSERT', service: mapDbSalonService(payload.new as Record<string, unknown>) });
        }
      })
      .subscribe();

    const turnCriteriaChan = supabase
      .channel('realtime:turn_criteria')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'turn_criteria' }, (payload) => {
        isApplyingRemoteRef.current = true;
        if (payload.eventType === 'DELETE') {
          const id = (payload.old as { id?: string } | null)?.id;
          if (id) dispatch({ type: 'REMOTE_TURN_CRITERIA_DELETE', id });
          else isApplyingRemoteRef.current = false;
        } else {
          dispatch({ type: 'REMOTE_TURN_CRITERIA_UPSERT', criteria: mapDbTurnCriteria(payload.new as Record<string, unknown>) });
        }
      })
      .subscribe();

    const calendarDaysChan = supabase
      .channel('realtime:calendar_days')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'calendar_days' }, (payload) => {
        isApplyingRemoteRef.current = true;
        if (payload.eventType === 'DELETE') {
          const date = (payload.old as { date?: string } | null)?.date;
          if (date) dispatch({ type: 'REMOTE_CALENDAR_DAY_DELETE', date });
          else isApplyingRemoteRef.current = false;
        } else {
          dispatch({ type: 'REMOTE_CALENDAR_DAY_UPSERT', day: mapDbCalendarDay(payload.new as Record<string, unknown>) });
        }
      })
      .subscribe();

    // system_state is a singleton and the reducer's REMOTE_SYSTEM_STATE_UPDATE case
    // returns state unchanged (no local field tracks it — the startup check reads from DB
    // directly). We therefore DO NOT set isApplyingRemoteRef here: if we did, the reducer
    // would short-circuit, useReducer would skip re-rendering, the sync effect would never
    // run, and the flag would stay true — poisoning the next real local change.
    const systemStateChan = supabase
      .channel('realtime:system_state')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'system_state' }, (payload) => {
        const newRow = payload.new as Record<string, unknown> | null;
        const lastArchiveDate = (newRow?.last_archive_date as string) ?? null;
        dispatch({ type: 'REMOTE_SYSTEM_STATE_UPDATE', lastArchiveDate });
      })
      .subscribe();

    return () => {
      supabase.removeChannel(manicuristsChan);
      supabase.removeChannel(queueChan);
      supabase.removeChannel(completedChan);
      supabase.removeChannel(appointmentsChan);
      supabase.removeChannel(salonServicesChan);
      supabase.removeChannel(turnCriteriaChan);
      supabase.removeChannel(calendarDaysChan);
      supabase.removeChannel(systemStateChan);
    };
  }, [state.loaded]);

  useEffect(() => {
    if (!state.loaded) return;

    function getMillisecondsUntilLaSalonClose(): number {
      const now = new Date();
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).formatToParts(now);
      const laHour   = Number(parts.find(p => p.type === 'hour')?.value   ?? '0');
      const laMinute = Number(parts.find(p => p.type === 'minute')?.value ?? '0');
      const laSecond = Number(parts.find(p => p.type === 'second')?.value ?? '0');

      const CLOSE_HOUR = 23; // 11pm LA â targets 11:59pm
      const currentLaSeconds = laHour * 3600 + laMinute * 60 + laSecond;
      const targetLaSeconds  = CLOSE_HOUR * 3600 + 59 * 60; // 11:59pm LA
      let deltaSeconds = targetLaSeconds - currentLaSeconds;
      if (deltaSeconds <= 0) deltaSeconds += 24 * 3600; // already past 9pm â target tomorrow
      return deltaSeconds * 1000;
    }

    function scheduleReset() {
      const msUntilClose = getMillisecondsUntilLaSalonClose();
      const timeoutId = setTimeout(() => {
        archiveTodayIfNeeded();
        scheduleReset();
      }, msUntilClose);
      return timeoutId;
    }

    const timeoutId = scheduleReset();
    return () => clearTimeout(timeoutId);
  }, [state.loaded, archiveTodayIfNeeded]);

  return (
    <AppContext.Provider value={{ state, dispatch, saveTodayHistory, archiveTodayIfNeeded, syncError, clearSyncError, saveStatus }}>
      {children}
    </AppContext.Provider>
  );
}

async function withRetry<T>(
  fn: () => PromiseLike<{ data?: T; error: unknown }>,
  retries = 3,
  delayMs = 2000
): Promise<{ data?: T; error: unknown }> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const result = await fn();
    if (!result.error) return result;
    if (attempt < retries) await new Promise(res => setTimeout(res, delayMs * attempt));
  }
  return fn();
}

// Per-row equality for Manicurist. Reference equality short-circuits for the common
// case (the reducer reused the same object). For changed references, compare the
// fields we actually persist — including stable JSON encodings of the array/object
// columns so structurally-equal blobs don't trigger writes.
function manicuristUnchanged(a: Manicurist, b: Manicurist, aIdx: number, bIdx: number): boolean {
  if (a === b && aIdx === bIdx) return true;
  return (
    aIdx === bIdx &&
    a.name === b.name &&
    a.color === b.color &&
    a.phone === b.phone &&
    a.clockedIn === b.clockedIn &&
    a.clockInTime === b.clockInTime &&
    a.totalTurns === b.totalTurns &&
    a.currentClient === b.currentClient &&
    a.status === b.status &&
    a.hasFourthPositionSpecial === b.hasFourthPositionSpecial &&
    a.hasCheck2 === b.hasCheck2 &&
    a.hasCheck3 === b.hasCheck3 &&
    a.hasWax === b.hasWax &&
    a.hasWax2 === b.hasWax2 &&
    a.hasWax3 === b.hasWax3 &&
    a.pinCode === b.pinCode &&
    a.breakStartTime === b.breakStartTime &&
    a.smsOptIn === b.smsOptIn &&
    a.showInBook === b.showInBook &&
    a.isReceptionist === b.isReceptionist &&
    JSON.stringify(a.skills) === JSON.stringify(b.skills) &&
    JSON.stringify(a.timeAdjustments || {}) === JSON.stringify(b.timeAdjustments || {})
  );
}

function manicuristToRow(m: Manicurist, idx: number) {
  return {
    id: m.id,
    name: m.name,
    color: m.color,
    phone: m.phone || null,
    skills: m.skills,
    clocked_in: m.clockedIn,
    clock_in_time: m.clockInTime ? new Date(m.clockInTime).toISOString() : null,
    total_turns: m.totalTurns,
    current_client_id: m.currentClient,
    status: m.status,
    has_fourth_position_special: m.hasFourthPositionSpecial,
    has_check2: m.hasCheck2,
    has_check3: m.hasCheck3,
    has_wax: m.hasWax,
    has_wax2: m.hasWax2,
    has_wax3: m.hasWax3,
    time_adjustments: m.timeAdjustments || {},
    pin_code: m.pinCode || null,
    break_start_time: m.breakStartTime ?? null,
    sms_opt_in: m.smsOptIn || false,
    sort_order: idx,
    show_in_book: m.showInBook !== false,
    is_receptionist: m.isReceptionist || false,
  };
}

async function syncManicurists(manicurists: Manicurist[], prev: Manicurist[], onError: (msg: string) => void) {
  const prevById = new Map(prev.map((m, idx) => [m.id, { m, idx }]));
  const changed: ReturnType<typeof manicuristToRow>[] = [];
  manicurists.forEach((m, idx) => {
    const previous = prevById.get(m.id);
    if (previous && manicuristUnchanged(previous.m, m, previous.idx, idx)) return;
    changed.push(manicuristToRow(m, idx));
  });
  if (changed.length === 0) return;
  const { error } = await withRetry(() => supabase.from('manicurists').upsert(changed, { onConflict: 'id' }));
  if (error) { console.error('[syncManicurists] error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
}

function queueEntryUnchanged(a: QueueEntry, b: QueueEntry): boolean {
  if (a === b) return true;
  return (
    a.clientName === b.clientName &&
    a.turnValue === b.turnValue &&
    a.requestedManicuristId === b.requestedManicuristId &&
    a.isRequested === b.isRequested &&
    a.isAppointment === b.isAppointment &&
    a.assignedManicuristId === b.assignedManicuristId &&
    a.status === b.status &&
    a.arrivedAt === b.arrivedAt &&
    a.startedAt === b.startedAt &&
    a.completedAt === b.completedAt &&
    a.extraTimeMs === b.extraTimeMs &&
    JSON.stringify(a.services) === JSON.stringify(b.services) &&
    JSON.stringify(a.serviceRequests) === JSON.stringify(b.serviceRequests)
  );
}

function queueEntryToRow(c: QueueEntry) {
  return {
    id: c.id,
    client_name: c.clientName,
    service: c.services[0] || '',
    services: c.services,
    turn_value: c.turnValue,
    service_requests: c.serviceRequests,
    requested_manicurist_id: c.requestedManicuristId,
    is_requested: c.isRequested,
    is_appointment: c.isAppointment,
    assigned_manicurist_id: c.assignedManicuristId,
    status: c.status,
    arrived_at: new Date(c.arrivedAt).toISOString(),
    started_at: c.startedAt ? new Date(c.startedAt).toISOString() : null,
    completed_at: c.completedAt ? new Date(c.completedAt).toISOString() : null,
    extra_time_ms: c.extraTimeMs || 0,
  };
}

async function syncQueue(queue: QueueEntry[], prev: QueueEntry[], onError: (msg: string) => void) {
  const prevById = new Map(prev.map((c) => [c.id, c]));
  const currentIds = new Set(queue.map((c) => c.id));

  // Deletes: rows in prev that are no longer in current state. Use .in() to batch.
  const removedIds = prev.filter((c) => !currentIds.has(c.id)).map((c) => c.id);
  if (removedIds.length > 0) {
    const { error } = await withRetry(() => supabase.from('queue_entries').delete().in('id', removedIds));
    if (error) { console.error('[syncQueue] delete error:', error); onError('Sync failed â data may not be saved. Check connection.'); }
  }

  // Upserts: only rows that are new or whose tracked fields changed. Batched into
  // one request instead of one round-trip per row.
  const changed: ReturnType<typeof queueEntryToRow>[] = [];
  for (const c of queue) {
    const previous = prevById.get(c.id);
    if (previous && queueEntryUnchanged(previous, c)) continue;
    changed.push(queueEntryToRow(c));
  }
  if (changed.length === 0) return;
  const { error: upsertErr } = await withRetry(() => supabase.from('queue_entries').upsert(changed, { onConflict: 'id' }));
  if (upsertErr) { console.error('[syncQueue] upsert error:', upsertErr); onError('Sync failed - data may not be saved. Check connection.'); }
}
//ZZZTRASH â

async function syncCompleted(completed: AppState['completed'], prev: AppState['completed'], onError: (msg: string) => void) {
  const prevById = new Map(prev.map((c) => [c.id, c]));
  const currentIds = new Set(completed.map((c) => c.id));

  // Handle deletes: entries in prev but not in current
  const removedIds = prev.filter((c) => !currentIds.has(c.id)).map((c) => c.id);
  if (removedIds.length > 0) {
    const { error } = await withRetry(() => supabase.from('completed_services').delete().in('id', removedIds));
    if (error) { console.error('[syncCompleted] delete error:', error); onError('Sync failed â data may not be saved. Check connection.'); }
  }

  // Handle inserts (new entries) and updates (entries that changed)
  for (const c of completed) {
    const previous = prevById.get(c.id);
    // Shallow compare the fields we sync â skip if identical reference AND same data
    if (previous && previous === c) continue;
    if (previous) {
      // Update â only push if any tracked field changed
      const unchanged =
        previous.clientName === c.clientName &&
        previous.turnValue === c.turnValue &&
        previous.manicuristId === c.manicuristId &&
        previous.manicuristName === c.manicuristName &&
        previous.manicuristColor === c.manicuristColor &&
        previous.startedAt === c.startedAt &&
        previous.completedAt === c.completedAt &&
        previous.isAppointment === c.isAppointment &&
        previous.isRequested === c.isRequested &&
        JSON.stringify(previous.services) === JSON.stringify(c.services) &&
        JSON.stringify(previous.requestedServices ?? []) === JSON.stringify(c.requestedServices ?? []);
      if (unchanged) continue;
    }
    const { error } = await withRetry(() => supabase.from('completed_services').upsert({
      id: c.id,
      client_name: c.clientName,
      service: c.services[0] || '',
      services: c.services,
      turn_value: c.turnValue,
      manicurist_id: c.manicuristId,
      manicurist_name: c.manicuristName,
      manicurist_color: c.manicuristColor,
      started_at: new Date(c.startedAt).toISOString(),
      completed_at: new Date(c.completedAt).toISOString(),
      requested_services: c.requestedServices ?? [],
      is_appointment: !!c.isAppointment,
      is_requested: !!c.isRequested,
    }, { onConflict: 'id' }));
    if (error) { console.error('[syncCompleted] upsert error:', error); onError('Sync failed â data may not be saved. Check connection.'); }
  }
}

async function syncDailyHistory(current: DailyHistory[], prev: DailyHistory[], onError: (msg: string) => void) {
  const prevByDate = new Map(prev.map((d) => [d.date, d]));
  for (const day of current) {
    const previous = prevByDate.get(day.date);
    if (previous && previous === day) continue;
    if (previous && JSON.stringify(previous.entries) === JSON.stringify(day.entries)) continue;
    // New day or changed entries â upsert
    const { error } = await supabase
      .from('daily_history')
      .upsert({ id: day.id, date: day.date, entries: day.entries }, { onConflict: 'date' });
    if (error) { console.error('[syncDailyHistory] upsert error:', error); onError('Sync failed â data may not be saved. Check connection.'); }
  }
}

async function syncAppointments(appointments: Appointment[], prev: Appointment[], onError: (msg: string) => void) {
  const currentIds = new Set(appointments.map((a) => a.id));

  const deleted = prev.filter((a) => !currentIds.has(a.id));
  for (const a of deleted) {
    const { error } = await withRetry(() => supabase.from('appointments').delete().eq('id', a.id));
    if (error) { console.error('[syncAppointments] delete error:', error); onError('Sync failed â data may not be saved. Check connection.'); }
  }

  for (const a of appointments) {
    const { error } = await withRetry(() => supabase.from('appointments').upsert({
      id: a.id,
      client_name: a.clientName,
      client_phone: a.clientPhone || null,
      service: a.services?.[0] || a.service,
      services: a.services || [a.service],
      service_requests: a.serviceRequests || [],
      manicurist_id: a.manicuristId || null,
      date: a.date,
      time: a.time,
      notes: a.notes || null,
      status: a.status,
      created_at: a.createdAt ? new Date(a.createdAt).toISOString() : new Date().toISOString(),
    }, { onConflict: 'id' }));
    if (error) { console.error('[syncAppointments] upsert error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
  }
}

function salonServiceUnchanged(a: SalonService, b: SalonService): boolean {
  if (a === b) return true;
  return (
    a.name === b.name &&
    a.turnValue === b.turnValue &&
    a.duration === b.duration &&
    a.price === b.price &&
    a.isActive === b.isActive &&
    a.category === b.category &&
    a.sortOrder === b.sortOrder &&
    a.isFourthPositionSpecial === b.isFourthPositionSpecial
  );
}

function salonServiceToRow(s: SalonService) {
  return {
    id: s.id,
    name: s.name,
    turn_value: s.turnValue,
    duration: s.duration,
    price: s.price,
    is_active: s.isActive,
    category: s.category,
    sort_order: s.sortOrder,
    is_fourth_position_special: s.isFourthPositionSpecial,
  };
}

async function syncSalonServices(salonServices: SalonService[], prev: SalonService[], onError: (msg: string) => void) {
  const currentIds = new Set(salonServices.map((s) => s.id));
  const removed = prev.filter((s) => !currentIds.has(s.id));
  if (removed.length > 0) {
    const { error } = await withRetry(() => supabase.from('salon_services').delete().in('id', removed.map((s) => s.id)));
    if (error) { console.error('[syncSalonServices] delete error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
  }
  // Per-row diff — only upsert services that actually changed since prev. This stops a stale
  // device from clobbering another device's recent edit by re-pushing every row on every save.
  const prevById = new Map(prev.map((s) => [s.id, s]));
  const changed: ReturnType<typeof salonServiceToRow>[] = [];
  for (const s of salonServices) {
    const previous = prevById.get(s.id);
    if (previous && salonServiceUnchanged(previous, s)) continue;
    changed.push(salonServiceToRow(s));
  }
  if (changed.length === 0) return;
  const { error } = await withRetry(() => supabase.from('salon_services').upsert(changed, { onConflict: 'id' }));
  if (error) { console.error('[syncSalonServices] upsert error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
}

function turnCriteriaUnchanged(a: TurnCriteria, b: TurnCriteria): boolean {
  if (a === b) return true;
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.priority === b.priority &&
    a.enabled === b.enabled &&
    a.type === b.type &&
    a.value === b.value
  );
}

function turnCriteriaToRow(c: TurnCriteria) {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    priority: c.priority,
    enabled: c.enabled,
    type: c.type,
    value: c.value,
  };
}

async function syncTurnCriteria(turnCriteria: TurnCriteria[], prev: TurnCriteria[], onError: (msg: string) => void) {
  const currentIds = new Set(turnCriteria.map((c) => c.id));
  const removed = prev.filter((c) => !currentIds.has(c.id));
  if (removed.length > 0) {
    const { error } = await withRetry(() => supabase.from('turn_criteria').delete().in('id', removed.map((c) => c.id)));
    if (error) { console.error('[syncTurnCriteria] delete error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
  }
  const prevById = new Map(prev.map((c) => [c.id, c]));
  const changed: ReturnType<typeof turnCriteriaToRow>[] = [];
  for (const c of turnCriteria) {
    const previous = prevById.get(c.id);
    if (previous && turnCriteriaUnchanged(previous, c)) continue;
    changed.push(turnCriteriaToRow(c));
  }
  if (changed.length === 0) return;
  const { error } = await withRetry(() => supabase.from