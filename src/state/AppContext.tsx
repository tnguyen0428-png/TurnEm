import { createContext, useContext, useReducer, useEffect, useRef, useCallback, type ReactNode } from 'react';
import type { AppState, Manicurist, QueueEntry, ServiceRequest, ServiceType, Appointment, SalonService, TurnCriteria, CalendarDay, DailyHistory, CompletedEntry } from '../types';
import type { AppAction } from './actions';
import { appReducer, INITIAL_STATE } from './reducer';
import { supabase } from '../lib/supabase';
import { defaultSalonServices } from '../constants/salonServices';
import { defaultManicurists } from '../constants/manicurists';
import { getLocalDateStr } from '../utils/time';

interface AppContextType {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  saveTodayHistory: (dateOverride?: string) => Promise<boolean>;
  archiveTodayIfNeeded: () => Promise<void>;
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
  };
}

function mapDbAppointment(row: Record<string, unknown>): Appointment {
  return {
    id: row.id as string,
    clientName: (row.client_name as string) || '',
    clientPhone: (row.client_phone as string) || '',
    service: row.service as ServiceType,
    manicuristId: (row.manicurist_id as string) || null,
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

function getTodayLA(): string {
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

// Module-level guard: prevents loadInitialData from running more than once per page load,
// even if Vite Fast Refresh re-mounts the component during development.
let _dataLoadStarted = false;

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, INITIAL_STATE);
  const prevStateRef = useRef<AppState>(INITIAL_STATE);

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
    // If serviceError is set it means the DB call failed — we must not overwrite with defaults.
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
    // A staffError means the DB call failed — seeding here would replace real data with defaults.
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
      };
    });

    // Persist the cleanup to DB for any bad entries we found above
    for (const e of completed) {
      const rawRow = (completedRows || []).find((r: Record<string, unknown>) => r.id === e.id);
      const rawRequested = Array.isArray(rawRow?.requested_services) ? rawRow.requested_services as string[] : [];
      if (rawRequested.length > 0 && e.requestedServices === undefined) {
        // This entry had bad data — clear it in the DB too
        await supabase.from('completed_services').update({ requested_services: [] }).eq('id', e.id);
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
        await supabase.from('daily_history').update({ entries: day.entries }).eq('id', day.id);
      }
    }

    dispatch({ type: 'LOAD_STATE', state: { manicurists, queue, completed, appointments, salonServices, turnCriteria, calendarDays, dailyHistory: cleanedHistory } });

    // Startup stale-data check: if the app wasn't open at reset time (9pm),
    // queue/completed entries from a previous day carry over. Detect and reset.
    const today = getTodayLA();
    const staleCompleted = completed.filter(c => getLocalDateStr(new Date(c.completedAt)) < today);
    const staleQueue = queue.filter(c => getLocalDateStr(new Date(c.arrivedAt)) < today);

    if (staleCompleted.length > 0 || staleQueue.length > 0) {
      console.log('[startup] stale data detected from previous day — archiving and resetting', { staleCompleted: staleCompleted.length, staleQueue: staleQueue.length });

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
        await supabase.from('daily_history').upsert(
          { id: historyEntry.id, date: historyEntry.date, entries: historyEntry.entries },
          { onConflict: 'date' }
        );
        // Update in-memory history so the history screen can find it immediately
        dispatch({ type: 'SAVE_DAILY_HISTORY', entry: historyEntry });
      }

      // Clear stale queue entries and completed services from DB
      for (const c of staleQueue) {
        await supabase.from('queue_entries').delete().eq('id', c.id);
      }
      if (staleCompleted.length > 0) {
        // Delete only the specific stale IDs — never use neq() here as it would wipe the whole table
        const staleIds = staleCompleted.map(c => c.id);
        const { error: deleteErr } = await supabase.from('completed_services').delete().in('id', staleIds);
        if (deleteErr) console.error('[startup] failed to delete stale completed_services:', deleteErr);
      }

      dispatch({ type: 'DAILY_RESET' });
    }
  }

  const saveTodayHistory = useCallback(async (dateOverride?: string): Promise<boolean> => {
    if (state.completed.length === 0) return true; // nothing to save — not an error
    const date = dateOverride ?? getTodayLA();
    // Reuse the existing entry's ID for this date so repeated saves don't generate a new
    // UUID each time (which would fight the onConflict 'date' upsert and change the stored id).
    const existingEntry = state.dailyHistory.find(h => h.date === date);
    const entry: DailyHistory = {
      id: existingEntry?.id ?? crypto.randomUUID(),
      date,
      entries: state.completed,
    };
    const { error } = await supabase
      .from('daily_history')
      .upsert({ id: entry.id, date: entry.date, entries: entry.entries }, { onConflict: 'date' });
    if (error) {
      console.error('[saveTodayHistory] upsert error:', error);
      return false; // caller must NOT dispatch or reset on failure
    }
    dispatch({ type: 'SAVE_DAILY_HISTORY', entry });
    return true;
  }, [state.completed, state.dailyHistory]);

  const archiveTodayIfNeeded = useCallback(async () => {
    const now = new Date();
    const laHour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        hour: '2-digit',
        hour12: false,
      }).format(now)
    );
    if (laHour < 23 || laHour >= 24) {
      console.error('[archiveTodayIfNeeded] aborted — not within rollover window', { laHour });
      return;
    }
    const saved = await saveTodayHistory();
    if (!saved) {
      // Save failed — do NOT reset. Keeping today's data in memory is safer than
      // wiping it. The scheduler will retry on the next tick.
      console.error('[archiveTodayIfNeeded] save failed — skipping DAILY_RESET to prevent data loss');
      return;
    }
    dispatch({ type: 'DAILY_RESET' });
  }, [saveTodayHistory]);

  useEffect(() => {
    if (!state.loaded) return;
    const prev = prevStateRef.current;
    // On the very first render after loadInitialData dispatches LOAD_STATE, prev still holds
    // INITIAL_STATE (all empty arrays). Syncing here would push empty state back to the DB
    // and race with the just-completed fetch. Skip this first run and just advance the ref.
    if (!prev.loaded) {
      prevStateRef.current = state;
      return;
    }
    if (prev.manicurists !== state.manicurists) syncManicurists(state.manicurists);
    if (prev.queue !== state.queue) syncQueue(state.queue);
    if (prev.completed !== state.completed) syncCompleted(state.completed, prev.completed);
    if (prev.appointments !== state.appointments) syncAppointments(state.appointments, prev.appointments);
    if (prev.salonServices !== state.salonServices) syncSalonServices(state.salonServices, prev.salonServices);
    if (prev.turnCriteria !== state.turnCriteria) syncTurnCriteria(state.turnCriteria);
    if (prev.calendarDays !== state.calendarDays) syncCalendarDays(state.calendarDays, prev.calendarDays);
    prevStateRef.current = state;
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

      const CLOSE_HOUR = 23; // 11pm LA — targets 11:59pm
      const currentLaSeconds = laHour * 3600 + laMinute * 60 + laSecond;
      const targetLaSeconds  = CLOSE_HOUR * 3600 + 59 * 60; // 11:59pm LA
      let deltaSeconds = targetLaSeconds - currentLaSeconds;
      if (deltaSeconds <= 0) deltaSeconds += 24 * 3600; // already past 9pm — target tomorrow
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
    <AppContext.Provider value={{ state, dispatch, saveTodayHistory, archiveTodayIfNeeded }}>
      {children}
    </AppContext.Provider>
  );
}

async function syncManicurists(manicurists: Manicurist[]) {
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
    }, { onConflict: 'id' });
    if (error) console.error('[syncManicurists] error:', error);
  }
}

async function syncQueue(queue: QueueEntry[]) {
  const { data: existing } = await supabase.from('queue_entries').select('id');
  const currentIds = new Set(queue.map((c) => c.id));
  const toDelete = (existing || []).filter((r: { id: string }) => !currentIds.has(r.id));
  for (const r of toDelete) {
    const { error } = await supabase.from('queue_entries').delete().eq('id', r.id);
    if (error) console.error('[syncQueue] delete error:', error);
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
    }, { onConflict: 'id' });
    if (error) console.error('[syncQueue] upsert error:', error);
  }
}

async function syncCompleted(completed: AppState['completed'], prev: AppState['completed']) {
  const prevIds = new Set(prev.map((c) => c.id));
  const newEntries = completed.filter((c) => !prevIds.has(c.id));
  for (const c of newEntries) {
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
    }, { onConflict: 'id' });
    if (error) console.error('[syncCompleted] upsert error:', error);
  }
  // When completed is cleared (daily reset or clear history), delete only the specific
  // IDs that were previously tracked — never use neq() which would wipe the whole table.
  if (completed.length === 0 && prev.length > 0) {
    const idsToDelete = [...prevIds];
    if (idsToDelete.length > 0) {
      const { error } = await supabase.from('completed_services').delete().in('id', idsToDelete);
      if (error) console.error('[syncCompleted] delete error:', error);
    }
  }
}

async function syncAppointments(appointments: Appointment[], prev: Appointment[]) {
  const currentIds = new Set(appointments.map((a) => a.id));

  const deleted = prev.filter((a) => !currentIds.has(a.id));
  for (const a of deleted) {
    const { error } = await supabase.from('appointments').delete().eq('id', a.id);
    if (error) console.error('[syncAppointments] delete error:', error);
  }

  for (const a of appointments) {
    const { error } = await supabase.from('appointments').upsert({
      id: a.id,
      client_name: a.clientName,
      client_phone: a.clientPhone,
      service: a.service,
      manicurist_id: a.manicuristId,
      date: a.date,
      time: a.time,
      notes: a.notes,
      status: a.status,
      created_at: new Date(a.createdAt).toISOString(),
    }, { onConflict: 'id' });
    if (error) console.error('[syncAppointments] upsert error:', error);
  }
}

async function syncSalonServices(services: SalonService[], prev: SalonService[]) {
  const currentIds = new Set(services.map((s) => s.id));

  const deleted = prev.filter((s) => !currentIds.has(s.id));
  for (const s of deleted) {
    const { error } = await supabase.from('salon_services').delete().eq('id', s.id);
    if (error) console.error('[syncSalonServices] delete error:', error);
  }

  for (const s of services) {
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
    if (error) console.error('[syncSalonServices] upsert error for', s.id, error);
  }
}

async function syncTurnCriteria(criteria: TurnCriteria[]) {
  for (const c of criteria) {
    const { error } = await supabase.from('turn_criteria').upsert({
      id: c.id,
      name: c.name,
      description: c.description,
      priority: c.priority,
      enabled: c.enabled,
      type: c.type,
      value: c.value,
    }, { onConflict: 'id' });
    if (error) console.error('[syncTurnCriteria] error:', error);
  }
}

async function syncCalendarDays(days: CalendarDay[], prev: CalendarDay[]) {
  const currentDates = new Set(days.map((d) => d.date));

  const deleted = prev.filter((d) => !currentDates.has(d.date));
  for (const d of deleted) {
    const { error } = await supabase.from('calendar_days').delete().eq('date', d.date);
    if (error) console.error('[syncCalendarDays] delete error:', error);
  }

  for (const d of days) {
    const { error } = await supabase.from('calendar_days').upsert({
      date: d.date,
      status: d.status,
      note: d.note,
    }, { onConflict: 'date' });
    if (error) console.error('[syncCalendarDays] upsert error:', error);
  }
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
