import { createContext, useContext, useReducer, useEffect, useRef, useCallback, type ReactNode } from 'react';
import type { AppState, Manicurist, QueueEntry, ServiceRequest, ServiceType, Appointment, SalonService, TurnCriteria, CalendarDay, DailyHistory, CompletedEntry } from '../types';
import type { AppAction } from './actions';
import { appReducer, INITIAL_STATE } from './reducer';
import { supabase } from '../lib/supabase';
import { ALL_SERVICES } from '../constants/services';

interface AppContextType {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
  saveTodayHistory: () => Promise<void>;
  resetForNewDay: () => Promise<void>;
}

const AppContext = createContext<AppContextType | null>(null);

const SEED_MANICURISTS: Manicurist[] = [
  {
    id: crypto.randomUUID(),
    name: 'Lisa',
    color: '#10b981',
    phone: '',
    skills: [...ALL_SERVICES],
    clockedIn: true,
    clockInTime: Date.now() - 3600000,
    totalTurns: 0,
    currentClient: null,
    status: 'available',
    hasFourthPositionSpecial: false,
    hasCheck2: false,
    hasCheck3: false,
    hasWax: false,
    hasWax2: false,
    hasWax3: false,
  },
  {
    id: crypto.randomUUID(),
    name: 'Maria',
    color: '#6366f1',
    phone: '',
    skills: ['Manicure', 'Pedicure', 'Fills'],
    clockedIn: true,
    clockInTime: Date.now() - 3000000,
    totalTurns: 0,
    currentClient: null,
    status: 'available',
    hasFourthPositionSpecial: false,
    hasCheck2: false,
    hasCheck3: false,
    hasWax: false,
    hasWax2: false,
    hasWax3: false,
  },
  {
    id: crypto.randomUUID(),
    name: 'Jenny',
    color: '#f59e0b',
    phone: '',
    skills: ['Acrylics/Full', 'Fills', 'Manicure'],
    clockedIn: true,
    clockInTime: Date.now() - 2400000,
    totalTurns: 0,
    currentClient: null,
    status: 'available',
    hasFourthPositionSpecial: false,
    hasCheck2: false,
    hasCheck3: false,
    hasWax: false,
    hasWax2: false,
    hasWax3: false,
  },
  {
    id: crypto.randomUUID(),
    name: 'Rosa',
    color: '#ec4899',
    phone: '',
    skills: [...ALL_SERVICES],
    clockedIn: false,
    clockInTime: null,
    totalTurns: 0,
    currentClient: null,
    status: 'available',
    hasFourthPositionSpecial: false,
    hasCheck2: false,
    hasCheck3: false,
    hasWax: false,
    hasWax2: false,
    hasWax3: false,
  },
];

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

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, INITIAL_STATE);
  const prevStateRef = useRef<AppState>(INITIAL_STATE);

  useEffect(() => {
    loadInitialData();
  }, []);

  async function loadInitialData() {
    const [
      { data: staffRows },
      { data: queueRows },
      { data: completedRows },
      { data: appointmentRows },
      { data: serviceRows },
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
    const salonServices = (serviceRows || []).map(mapDbSalonService);
    const turnCriteria = (criteriaRows || []).map(mapDbTurnCriteria);
    const calendarDays = (calendarRows || []).map(mapDbCalendarDay);
    const dailyHistory: DailyHistory[] = (dailyHistoryRows || []).map((row: Record<string, unknown>) => ({
      id: row.id as string,
      date: row.date as string,
      entries: (row.entries as CompletedEntry[]) || [],
    }));

    if (staffRows && staffRows.length > 0) {
      const manicurists = staffRows.map(mapDbManicurist);
      const queue = (queueRows || []).map(mapDbQueueEntry);
      const completed = (completedRows || []).map((row: Record<string, unknown>) => {
        const dbSvcs = row.services as string[] | null;
        const fallbackSvc = row.service as string;
        return {
          id: row.id as string,
          clientName: row.client_name as string,
          services: (dbSvcs && dbSvcs.length > 0 ? dbSvcs : [fallbackSvc]).filter(Boolean) as ServiceType[],
          turnValue: Number(row.turn_value) || 0,
          manicuristId: row.manicurist_id as string,
          manicuristName: row.manicurist_name as string,
          manicuristColor: row.manicurist_color as string,
          startedAt: new Date(row.started_at as string).getTime(),
          completedAt: new Date(row.completed_at as string).getTime(),
        };
      });
      dispatch({ type: 'LOAD_STATE', state: { manicurists, queue, completed, appointments, salonServices, turnCriteria, calendarDays, dailyHistory } });
    } else {
      for (const m of SEED_MANICURISTS) {
        await supabase.from('manicurists').insert({
          id: m.id,
          name: m.name,
          color: m.color,
          skills: m.skills,
          clocked_in: m.clockedIn,
          clock_in_time: m.clockInTime ? new Date(m.clockInTime).toISOString() : null,
          total_turns: m.totalTurns,
          current_client_id: m.currentClient,
          status: m.status,
        });
      }
      const walkIn: QueueEntry = {
        id: crypto.randomUUID(),
        clientName: 'Walk-in',
        services: ['Pedicure'],
        turnValue: 1.0,
        serviceRequests: [],
        requestedManicuristId: null,
        isRequested: false,
        isAppointment: false,
        assignedManicuristId: null,
        status: 'waiting',
        arrivedAt: Date.now() - 900000,
        startedAt: null,
        completedAt: null,
      };
      const sarah: QueueEntry = {
        id: crypto.randomUUID(),
        clientName: 'Sarah',
        services: ['Manicure'],
        turnValue: 0.5,
        serviceRequests: [],
        requestedManicuristId: null,
        isRequested: false,
        isAppointment: false,
        assignedManicuristId: null,
        status: 'waiting',
        arrivedAt: Date.now() - 480000,
        startedAt: null,
        completedAt: null,
      };
      for (const c of [walkIn, sarah]) {
        await supabase.from('queue_entries').insert({
          id: c.id,
          client_name: c.clientName,
          service: c.services[0],
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
        });
      }
      dispatch({
        type: 'LOAD_STATE',
        state: {
          manicurists: SEED_MANICURISTS,
          queue: [walkIn, sarah],
          completed: [],
          appointments,
          salonServices,
          turnCriteria,
          calendarDays,
          dailyHistory,
        },
      });
    }
  }

  const saveTodayHistory = useCallback(async () => {
    if (state.completed.length === 0) return;
    const today = new Date().toISOString().slice(0, 10);
    const entry: DailyHistory = {
      id: crypto.randomUUID(),
      date: today,
      entries: state.completed,
    };
    await supabase.from('daily_history').upsert({ id: entry.id, date: entry.date, entries: entry.entries }, { onConflict: 'date' });
    dispatch({ type: 'SAVE_DAILY_HISTORY', entry });
  }, [state.completed]);

  const resetForNewDay = useCallback(async () => {
    await saveTodayHistory();

    const resetManicurists = state.manicurists.map(m => ({
      ...m,
      totalTurns: 0,
      currentClient: null,
      status: 'available' as const,
      hasFourthPositionSpecial: false,
      hasCheck2: false,
      hasCheck3: false,
      hasWax: false,
      hasWax2: false,
      hasWax3: false,
    }));

    dispatch({
      type: 'LOAD_STATE',
      state: {
        manicurists: resetManicurists,
        queue: [],
        completed: [],
      },
    });
  }, [state.manicurists, state.completed, saveTodayHistory]);

  useEffect(() => {
    if (!state.loaded) return;
    const prev = prevStateRef.current;
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

    function getMillisecondsUntil1159PM() {
      const now = new Date();
      const target = new Date(now);
      target.setHours(23, 59, 0, 0);

      if (now.getTime() >= target.getTime()) {
        target.setDate(target.getDate() + 1);
      }

      return target.getTime() - now.getTime();
    }

    function scheduleReset() {
      const msUntil1159 = getMillisecondsUntil1159PM();

      const timeoutId = setTimeout(() => {
        resetForNewDay();
        scheduleReset();
      }, msUntil1159);

      return timeoutId;
    }

    const timeoutId = scheduleReset();
    return () => clearTimeout(timeoutId);
  }, [state.loaded, resetForNewDay]);

  return (
    <AppContext.Provider value={{ state, dispatch, saveTodayHistory, resetForNewDay }}>
      {children}
    </AppContext.Provider>
  );
}

async function syncManicurists(manicurists: Manicurist[]) {
  for (const m of manicurists) {
    await supabase.from('manicurists').upsert({
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
    });
  }
}

async function syncQueue(queue: QueueEntry[]) {
  const { data: existing } = await supabase.from('queue_entries').select('id');
  const currentIds = new Set(queue.map((c) => c.id));
  const toDelete = (existing || []).filter((r: { id: string }) => !currentIds.has(r.id));
  for (const r of toDelete) {
    await supabase.from('queue_entries').delete().eq('id', r.id);
  }
  for (const c of queue) {
    await supabase.from('queue_entries').upsert({
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
    });
  }
}

async function syncCompleted(completed: AppState['completed'], prev: AppState['completed']) {
  const prevIds = new Set(prev.map((c) => c.id));
  const newEntries = completed.filter((c) => !prevIds.has(c.id));
  for (const c of newEntries) {
    await supabase.from('completed_services').upsert({
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
    });
  }
  if (completed.length === 0 && prev.length > 0) {
    await supabase.from('completed_services').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  }
}

async function syncAppointments(appointments: Appointment[], prev: Appointment[]) {
  const currentIds = new Set(appointments.map((a) => a.id));

  const deleted = prev.filter((a) => !currentIds.has(a.id));
  for (const a of deleted) {
    await supabase.from('appointments').delete().eq('id', a.id);
  }

  for (const a of appointments) {
    await supabase.from('appointments').upsert({
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
    });
  }
}

async function syncSalonServices(services: SalonService[], prev: SalonService[]) {
  const currentIds = new Set(services.map((s) => s.id));

  const deleted = prev.filter((s) => !currentIds.has(s.id));
  for (const s of deleted) {
    await supabase.from('salon_services').delete().eq('id', s.id);
  }

  for (const s of services) {
    await supabase.from('salon_services').upsert({
      id: s.id,
      name: s.name,
      turn_value: s.turnValue,
      duration: s.duration,
      price: s.price,
      is_active: s.isActive,
      category: s.category,
      sort_order: s.sortOrder,
      is_fourth_position_special: s.isFourthPositionSpecial,
    });
  }
}

async function syncTurnCriteria(criteria: TurnCriteria[]) {
  for (const c of criteria) {
    await supabase.from('turn_criteria').upsert({
      id: c.id,
      name: c.name,
      description: c.description,
      priority: c.priority,
      enabled: c.enabled,
      type: c.type,
      value: c.value,
    });
  }
}

async function syncCalendarDays(days: CalendarDay[], prev: CalendarDay[]) {
  const currentDates = new Set(days.map((d) => d.date));

  const deleted = prev.filter((d) => !currentDates.has(d.date));
  for (const d of deleted) {
    await supabase.from('calendar_days').delete().eq('date', d.date);
  }

  for (const d of days) {
    await supabase.from('calendar_days').upsert({
      date: d.date,
      status: d.status,
      note: d.note,
    });
  }
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
