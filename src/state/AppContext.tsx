import { createContext, useContext, useReducer, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import type { AppState, Manicurist, QueueEntry, ServiceRequest, ServiceType, Appointment, SalonService, TurnCriteria, CalendarDay, DailyHistory, CompletedEntry } from '../types';
import type { AppAction } from './actions';
import { appReducer, INITIAL_STATE } from './reducer';
import { supabase } from '../lib/supabase';
import { defaultSalonServices } from '../constants/salonServices';
import { defaultManicurists } from '../constants/manicurists';
import { getLocalDateStr, getTodayLA } from '../utils/time';

interface AppContextType {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  saveTodayHistory: (dateOverride?: string) => Promise<boolean>;
  archiveTodayIfNeeded: (skipHourCheck?: boolean) => Promise<void>;
  syncError: string | null;
  clearSyncError: () => void;
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
    breakStartTime: row.break_start_time ? new Date(row.break_start_time as string).getTime() : null,
    smsOptIn: (row.sms_opt_in as boolean) || false,
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
  const clearSyncError = useCallback(() => setSyncError(null), []);
  const prevStateRef = useRef<AppState>(INITIAL_STATE);
  const completedRef = useRef<AppState['completed']>(INITIAL_STATE.completed);
  const dailyHistoryRef = useRef<AppState['dailyHistory']>(INITIAL_STATE.dailyHistory);

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
      supabase.from('manicurists').select('*'),
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
          break_start_time: m.breakStartTime ? new Date(m.breakStartTime).toISOString() : null,
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
    // Staff mode is read-only â never sync back to DB
    if (isStaffMode) {
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
    if (prev.manicurists !== state.manicurists) syncManicurists(state.manicurists, setSyncError);
    if (prev.queue !== state.queue) syncQueue(state.queue, setSyncError);
    if (prev.completed !== state.completed) syncCompleted(state.completed, prev.completed, setSyncError);
    if (prev.appointments !== state.appointments) syncAppointments(state.appointments, prev.appointments, setSyncError);
    if (prev.salonServices !== state.salonServices) syncSalonServices(state.salonServices, prev.salonServices, setSyncError);
    if (prev.turnCriteria !== state.turnCriteria) syncTurnCriteria(state.turnCriteria, setSyncError);
    if (prev.calendarDays !== state.calendarDays) syncCalendarDays(state.calendarDays, prev.calendarDays, setSyncError);
    if (prev.dailyHistory !== state.dailyHistory) syncDailyHistory(state.dailyHistory, prev.dailyHistory, setSyncError);
    prevStateRef.current = state;
    completedRef.current = state.completed;
    dailyHistoryRef.current = state.dailyHistory;
  }, [state]);

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
    <AppContext.Provider value={{ state, dispatch, saveTodayHistory, archiveTodayIfNeeded, syncError, clearSyncError }}>
      {children}
    </AppContext.Provider>
  );
}

async function syncManicurists(manicurists: Manicurist[], onError: (msg: string) => void) {
  for (const m of manicurists) {
    const { error } = await supabase.from('manicurists').upsert({
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
      break_start_time: m.breakStartTime ? new Date(m.breakStartTime).toISOString() : null,
      sms_opt_in: m.smsOptIn || false,
    }, { onConflict: 'id' });
    if (error) { console.error('[syncManicurists] error:', error); onError('Sync failed â data may not be saved. Check connection.'); }
  }
}

async function syncQueue(queue: QueueEntry[], onError: (msg: string) => void) {
  const { data: existing } = await supabase.from('queue_entries').select('id');
  const currentIds = new Set(queue.map((c) => c.id));
  const toDelete = (existing || []).filter((r: { id: string }) => !currentIds.has(r.id));
  for (const r of toDelete) {
    const { error } = await supabase.from('queue_entries').delete().eq('id', r.id);
    if (error) { console.error('[syncQueue] delete error:', error); onError('Sync failed â data may not be saved. Check connection.'); }
  }
  for (const c of queue) {
    const { error } = await supabase.from('queue_entries').upsert({
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
    }, { onConflict: 'id' });
    if (error) { console.error('[syncQueue] upsert error:', error); onError('Sync failed â data may not be saved. Check connection.'); }
  }
}

async function syncCompleted(completed: AppState['completed'], prev: AppState['completed'], onError: (msg: string) => void) {
  const prevById = new Map(prev.map((c) => [c.id, c]));
  const currentIds = new Set(completed.map((c) => c.id));

  // Handle deletes: entries in prev but not in current
  const removedIds = prev.filter((c) => !currentIds.has(c.id)).map((c) => c.id);
  if (removedIds.length > 0) {
    const { error } = await supabase.from('completed_services').delete().in('id', removedIds);
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
    const { error } = await supabase.from('completed_services').upsert({
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
    }, { onConflict: 'id' });
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
    const { error } = await supabase.from('appointments').delete().eq('id', a.id);
    if (error) { console.error('[syncAppointments] delete error:', error); onError('Sync failed â data may not be saved. Check connection.'); }
  }

  for (const a of appointments) {
    const { error } = await supabase.from('appointments').upsert({
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
    }, { onConflict: 'id' });
    if (error) { console.error('[syncAppointments] upsert error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
  }
}

async function syncSalonServices(salonServices: SalonService[], prev: SalonService[], onError: (msg: string) => void) {
  const currentIds = new Set(salonServices.map((s) => s.id));
  const deleted = prev.filter((s) => !currentIds.has(s.id));
  for (const s of deleted) {
    const { error } = await supabase.from('salon_services').delete().eq('id', s.id);
    if (error) { console.error('[syncSalonServices] delete error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
  }
  for (const s of salonServices) {
    const { error } = await supabase.from('salon_services').upsert({
      id: s.id,
      name: s.name,
      turn_value: s.turnValue,
      duration: s.duration,
      price: s.price,
      is_active: s.isActive,
      category: s.category,
      sort_order: s.sortOrder,
      is_fourth_position_special: s.isFourthPositionSpecial,
    }, { onConflict: 'id' });
    if (error) { console.error('[syncSalonServices] upsert error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
  }
}

async function syncTurnCriteria(turnCriteria: TurnCriteria[], onError: (msg: string) => void) {
  for (const c of turnCriteria) {
    const { error } = await supabase.from('turn_criteria').upsert({
      id: c.id,
      name: c.name,
      description: c.description,
      priority: c.priority,
      enabled: c.enabled,
      type: c.type,
      value: c.value,
    }, { onConflict: 'id' });
    if (error) { console.error('[syncTurnCriteria] upsert error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
  }
}

async function syncCalendarDays(calendarDays: CalendarDay[], prev: CalendarDay[], onError: (msg: string) => void) {
  const currentDates = new Set(calendarDays.map((d) => d.date));
  const deleted = prev.filter((d) => !currentDates.has(d.date));
  for (const d of deleted) {
    const { error } = await supabase.from('calendar_days').delete().eq('date', d.date);
    if (error) { console.error('[syncCalendarDays] delete error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
  }
  for (const d of calendarDays) {
    const { error } = await supabase.from('calendar_days').upsert({
      date: d.date,
      status: d.status,
      note: d.note,
    }, { onConflict: 'date' });
    if (error) { console.error('[syncCalendarDays] upsert error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
  }
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
