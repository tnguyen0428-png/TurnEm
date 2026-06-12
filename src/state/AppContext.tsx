import { createContext, useContext, useReducer, useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react';
import { appendItemsToTicket, backfillTicketAppointment, backfillTicketStaff, cleanupDuplicateLinesForEntry, createTicketAtCheckin, fetchTicketByQueueEntry, findOpenTicketForClient, getVisitId, removeOrphanTicketLines, removeTicketLinesByEntryPrefix, syncEntryToTicket } from '../lib/tickets';
import type { AppState, Manicurist, QueueEntry, ServiceRequest, ServiceType, Appointment, SalonService, TurnCriteria, CalendarDay, DailyHistory, CompletedEntry, StaffScheduleEntry, StaffScheduleOverride, StaffTimeOff } from '../types';
import type { AppAction } from './actions';
import { appReducer, INITIAL_STATE } from './reducer';
import { supabase, fetchAllRows } from '../lib/supabase';
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
  // Persist Blueprint priority lists. Writes to Supabase singleton system_state row,
  // updates local state via SET_PRIORITY dispatch, and mirrors to localStorage so the
  // legacy reads in assignHelpers.getDistinctServices keep working. Both args optional —
  // pass only the dimension you changed (categoryPriority OR servicePriority).
  setPriority: (next: { categoryPriority?: string[]; servicePriority?: Record<string, string[]> }) => Promise<void>;
}

// localStorage keys mirrored from utils/priorityStorage. Duplicated here so the
// AppContext doesn't have to import from a UI module — the Realtime handler and
// initial-load path both write these so legacy reads (assignHelpers) continue working.
const CAT_PRIORITY_KEY = 'turnem_category_priority';
const SVC_PRIORITY_KEY = 'turnem_service_priority';

function readLocalCatPriority(): string[] | null {
  try {
    const raw = localStorage.getItem(CAT_PRIORITY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function readLocalSvcPriority(): Record<string, string[]> | null {
  try {
    const raw = localStorage.getItem(SVC_PRIORITY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

const AppContext = createContext<AppContextType | null>(null);

// Separate dispatch context so dispatch-only consumers (modals, action buttons
// that fire reducer actions but never read state) don't re-render when state
// changes. The dispatch reference is stable from useReducer, so this context
// value never changes after mount.
const AppDispatchContext = createContext<React.Dispatch<AppAction> | null>(null);


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
    notificationBody: (row.notification_body as string) || '',
  };
}

function mapDbServiceRequest(r: Record<string, unknown>): ServiceRequest {
  // Preserve clientRequest, startTime, and durationAdjustment fields when round-
  // tripping through the DB. Dropping them would silently demote real customer
  // requests or lose per-appointment duration tweaks once the row syncs back.
  const clientRequest = r.clientRequest === true ? true : undefined;
  const startTime = typeof r.startTime === 'string' ? r.startTime : undefined;
  const durationAdjustment = typeof r.durationAdjustment === 'number' && r.durationAdjustment !== 0
    ? r.durationAdjustment
    : undefined;
  if (Array.isArray(r.manicuristIds)) {
    return {
      service: r.service as ServiceType,
      manicuristIds: r.manicuristIds as string[],
      ...(clientRequest !== undefined ? { clientRequest } : {}),
      ...(startTime !== undefined ? { startTime } : {}),
      ...(durationAdjustment !== undefined ? { durationAdjustment } : {}),
    };
  }
  const legacy = r.manicuristId as string | null;
  return {
    service: r.service as ServiceType,
    manicuristIds: legacy ? [legacy] : [],
    ...(clientRequest !== undefined ? { clientRequest } : {}),
    ...(startTime !== undefined ? { startTime } : {}),
    ...(durationAdjustment !== undefined ? { durationAdjustment } : {}),
  };
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
    parentQueueId: (row.parent_queue_id as string) || (row.id as string),
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
    originalAppointment: (row.original_appointment as Appointment | null) || undefined,
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
    // completed_at is nullable in the DB (in-progress rows from the
    // queue_entries trigger have completed_at = NULL). Guard against
    // calling new Date(null), which yields NaN and breaks
    // syncCompleted's diff comparison + re-upload.
    completedAt: row.completed_at ? new Date(row.completed_at as string).getTime() : null,
    requestedServices: rawRequested.length > 0 ? rawRequested as ServiceType[] : undefined,
    isAppointment: (row.is_appointment as boolean) || false,
    isRequested: (row.is_requested as boolean) || false,
    edited: (row.edited as boolean) || false,
    voided: (row.voided as boolean) || false,
    // Set by the trg_sync_completed_service_prices DB trigger on ticket close.
    // Null while the ticket is still open or for pre-trigger legacy rows.
    priceCents: row.price_cents == null ? null : Number(row.price_cents),
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
    sameTime: (row.same_time as boolean) || false,
    partyId: (row.party_id as string) || null,
    // `caution` column may not exist on older DBs yet — coalesce undefined to false.
    caution: (row.caution as boolean | undefined) || false,
    // `is_walk_in` flags auto-created appt blocks from the queue-assign flow.
    isWalkIn: (row.is_walk_in as boolean | undefined) || false,
    bookedByReceptionistId: (row.booked_by_receptionist_id as string) || null,
    lastEditedByReceptionistId: (row.last_edited_by_receptionist_id as string) || null,
    lastEditedAt: row.last_edited_at
      ? new Date(row.last_edited_at as string).getTime()
      : null,
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

// Postgres `time` columns may serialize as 'HH:MM:SS' or 'HH:MM'. The UI works
// in 'HH:MM', so strip seconds if present and pass through nulls untouched.
function timeToHHMM(v: unknown): string {
  if (typeof v !== 'string') return '00:00';
  return v.length >= 5 ? v.slice(0, 5) : v;
}

function mapDbStaffSchedule(row: Record<string, unknown>): StaffScheduleEntry {
  return {
    id: row.id as string,
    manicuristId: row.manicurist_id as string,
    weekday: Number(row.weekday),
    startTime: timeToHHMM(row.start_time),
    endTime: timeToHHMM(row.end_time),
    lunchStart: row.lunch_start ? timeToHHMM(row.lunch_start) : null,
    lunchEnd: row.lunch_end ? timeToHHMM(row.lunch_end) : null,
  };
}

function mapDbStaffTimeOff(row: Record<string, unknown>): StaffTimeOff {
  return {
    id: row.id as string,
    manicuristId: row.manicurist_id as string,
    startDate: row.start_date as string,
    endDate: row.end_date as string,
    reason: (row.reason as string) || '',
    createdAt: row.created_at ? new Date(row.created_at as string).getTime() : Date.now(),
  };
}

function mapDbStaffScheduleOverride(row: Record<string, unknown>): StaffScheduleOverride {
  return {
    id: row.id as string,
    manicuristId: row.manicurist_id as string,
    date: row.date as string,
    working: row.is_working === false ? false : true,
    startTime: timeToHHMM(row.start_time),
    endTime: timeToHHMM(row.end_time),
    lunchStart: row.lunch_start ? timeToHHMM(row.lunch_start) : null,
    lunchEnd: row.lunch_end ? timeToHHMM(row.lunch_end) : null,
    createdAt: row.created_at ? new Date(row.created_at as string).getTime() : Date.now(),
  };
}


// Module-level guard: prevents loadInitialData from running more than once per page load,
// even if Vite Fast Refresh re-mounts the component during development.
let _dataLoadStarted = false;

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, rawDispatch] = useReducer(appReducer, INITIAL_STATE);
  // Intentional-deletion ledger. The sync delete-detection below infers
  // "this appointment was deleted" from a diff of in-memory state, then issues
  // a real DB DELETE. A sync/realtime batching race can transiently drop a
  // still-valid booking from state, and the diff would then destroy it for good
  // (the "existing appt disappears, sometimes on time-adjust" reports; same
  // class as the Christina 5/27 / Megan 5/28 deletions). Booked appts only ever
  // leave state via an explicit DELETE_APPOINTMENT (trash icon / modal cancel /
  // last-service-removed) or a tombstoned remote delete — so we record the
  // explicit ones here and let the diff delete a BOOKED row only if it's in this
  // set. Walk-in synth blocks (high-churn, low-stakes) are still allowed through
  // the diff unconditionally. dispatch stays referentially stable (no deps).
  const pendingApptDeletesRef = useRef<Set<string>>(new Set());
  // Same protection for completed_services as for appointments above: a completed
  // row must only be DELETED from the DB when the user explicitly removed it, never
  // because it transiently fell out of in-memory `state.completed` during a sync /
  // realtime race. Without this, a partial reload silently deleted real turn history
  // (the 6/5 "missing morning turns" incident). We record explicit single deletes
  // here, and flag the two legitimate bulk clears (the History "Clear" button and the
  // post-save nightly DAILY_RESET) so syncCompleted's diff-delete only fires for
  // genuine user intent. A completed row that merely goes missing is left in the DB
  // and self-heals on the next load.
  const pendingCompletedDeletesRef = useRef<Set<string>>(new Set());
  const bulkCompletedClearRef = useRef<boolean>(false);
  const dispatch = useCallback<React.Dispatch<AppAction>>((action) => {
    if (action.type === 'DELETE_APPOINTMENT') {
      pendingApptDeletesRef.current.add(action.id);
    } else if (action.type === 'DELETE_COMPLETED') {
      pendingCompletedDeletesRef.current.add(action.id);
    } else if (action.type === 'CLEAR_HISTORY' || action.type === 'DAILY_RESET') {
      // Both clear `state.completed` wholesale by design. CLEAR_HISTORY is the
      // History screen's red Clear button (gated behind a successful save);
      // DAILY_RESET only fires after saveTodayHistory() succeeds. Authorize the
      // next syncCompleted flush to delete every removed row.
      bulkCompletedClearRef.current = true;
    }
    rawDispatch(action);
  }, []);
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
  const manicuristsRef = useRef<AppState['manicurists']>(INITIAL_STATE.manicurists);

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

  // Per-table write chain: every appointments-table write (upsert OR delete) is queued onto
  // this promise so they execute strictly in dispatch order. Without this, two trackSave
  // calls (e.g. an edit's UPSERT followed quickly by a delete) run in parallel — and if the
  // DELETE lands first then the in-flight UPSERT lands second, the row is recreated in the
  // DB. The tombstone protects this tab from the realtime echo, but other tabs (and this tab
  // after the tombstone expires) see the resurrected row. Serializing writes eliminates the
  // race entirely.
  const appointmentWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  const chainAppointmentWrite = useCallback((fn: () => Promise<void>): Promise<void> => {
    // The trailing .catch absorbs rejections so the chain promise always resolves —
    // a failed write is logged but does not deadlock the queue. fn runs only as
    // the success handler of the previous link; we deliberately do NOT pass fn in
    // the rejection slot of .then() so that a future maintainer who removes the
    // .catch doesn't accidentally start invoking fn on rejection (which would be
    // very surprising behavior). Serialization is preserved either way.
    const next = appointmentWriteChainRef.current.then(fn).catch((err) => {
      console.error('[appointmentWriteChain] error:', err);
    });
    appointmentWriteChainRef.current = next;
    return next;
  }, []);

  useEffect(() => {
    if (!_dataLoadStarted) {
      _dataLoadStarted = true;
      loadInitialData();
    }
  }, []);

  // When a tab is hidden, the browser throttles its WebSocket and it can miss realtime
  // events. On return-to-foreground we re-fetch appointments from DB so this tab can't
  // push a stale local copy back over a row another tab just deleted.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    async function reconcileAppts() {
      if (document.visibilityState !== 'visible') return;
      // Retry on transient failures: tab-wake hits often catch a half-reconnected
      // WebSocket / DNS resolve race. If retries are exhausted, surface a banner
      // instead of silently leaving the tab stale until the next focus event.
      // Paginate — without this, reconcile-on-focus would silently truncate at
      // 1000 rows once the table grows past that, leaving the tab stale.
      // (Upsert reducer means no rows get dropped from state, but new edits to
      // truncated-off appointments would never land.)
      const { data, error } = await withRetry(() => fetchAllRows(() => supabase.from('appointments').select('*')));
      if (error) {
        setSyncErrorTracked('Sync failed — could not refresh appointments after focus. Check connection.');
        return;
      }
      if (!data) return;
      // Dispatch each fresh appointment via REMOTE_APPOINTMENT_UPSERT — same
      // path the realtime channel uses. The UPSERT reducer inserts new IDs and
      // updates existing ones, but NEVER drops appointments from state.
      //
      // Previously this dispatched LOAD_STATE with the filtered fresh list,
      // wholesale-replacing state.appointments. Any id missing from `fresh`
      // (tombstoned-but-still-valid, or an in-flight race) was treated by the
      // sync effect's delete-detection as a local delete and propagated as a
      // SQL DELETE to DB — silently destroying live appointments while their
      // staff were still mid-service (Christina 2026-05-27, Megan 2026-05-28).
      //
      // Tombstoned IDs are skipped — their DELETE may still be in flight; we
      // don't want to re-add a row the user just deleted.
      for (const row of data) {
        const appt = mapDbAppointment(row as Record<string, unknown>);
        if (isTombstoned(appt.id)) continue;
        isApplyingRemoteRef.current = true;
        dispatch({ type: 'REMOTE_APPOINTMENT_UPSERT', appointment: appt });
      }
    }
    document.addEventListener('visibilitychange', reconcileAppts);
    window.addEventListener('focus', reconcileAppts);
    return () => {
      document.removeEventListener('visibilitychange', reconcileAppts);
      window.removeEventListener('focus', reconcileAppts);
    };
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
      { data: scheduleRows },
      { data: timeOffRows },
      { data: scheduleOverrideRows },
    ] = await Promise.all([
      // Every fetch here goes through fetchAllRows so the PostgREST 1000-row
      // Range default never silently truncates the response. The appointments
      // table hit this on 2026-05-30 (Sarah Samuelian's 10:00 multi-staff
      // booking disappeared); the rest are smaller today but will get the same
      // treatment as they grow — completed_services and daily_history in
      // particular accumulate forever.
      fetchAllRows(() => supabase.from('manicurists').select('*').order('sort_order', { ascending: true })),
      fetchAllRows(() => supabase.from('queue_entries').select('*')),
      fetchAllRows(() => supabase.from('completed_services').select('*')),
      fetchAllRows(() => supabase.from('appointments').select('*')),
      fetchAllRows(() => supabase.from('salon_services').select('*').order('sort_order')),
      fetchAllRows(() => supabase.from('turn_criteria').select('*')),
      fetchAllRows(() => supabase.from('calendar_days').select('*')),
      fetchAllRows(() => supabase.from('daily_history').select('*').order('date', { ascending: false })),
      fetchAllRows(() => supabase.from('staff_schedules').select('*')),
      fetchAllRows(() => supabase.from('staff_time_off').select('*')),
      fetchAllRows(() => supabase.from('staff_schedule_overrides').select('*')),
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
    const staffSchedules = (scheduleRows || []).map(mapDbStaffSchedule);
    const staffTimeOff = (timeOffRows || []).map(mapDbStaffTimeOff);
    const staffScheduleOverrides = (scheduleOverrideRows || []).map(mapDbStaffScheduleOverride);
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
        // Null when work is still in progress (queue_entries trigger).
        completedAt: row.completed_at ? new Date(row.completed_at as string).getTime() : null,
        requestedServices: isBadPattern ? undefined : (rawRequested.length > 0 ? rawRequested as ServiceType[] : undefined),
        isAppointment: (row.is_appointment as boolean) || false,
        isRequested: (row.is_requested as boolean) || false,
        priceCents: row.price_cents == null ? null : Number(row.price_cents),
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

    // Priority list: load from system_state singleton. If DB null but localStorage has values,
    // perform a one-time migration so the existing settings on this device aren't blown away.
    // We mirror the chosen values into localStorage so legacy reads in
    // assignHelpers.getDistinctServices keep working.
    const localCat = readLocalCatPriority();
    const localSvc = readLocalSvcPriority();

    let initialCatPriority: string[] = [];
    let initialSvcPriority: Record<string, string[]> = {};

    const { data: priorityRow } = await supabase
      .from('system_state')
      .select('category_priority, service_priority')
      .eq('id', 'singleton')
      .single();
    const dbCatPriority = (priorityRow as Record<string, unknown> | null)?.category_priority as string[] | null;
    const dbSvcPriority = (priorityRow as Record<string, unknown> | null)?.service_priority as Record<string, string[]> | null;

    if (Array.isArray(dbCatPriority)) {
      initialCatPriority = dbCatPriority;
      try { localStorage.setItem(CAT_PRIORITY_KEY, JSON.stringify(dbCatPriority)); } catch {}
    } else if (localCat && localCat.length > 0) {
      initialCatPriority = localCat;
      const { error: migErr } = await supabase
        .from('system_state')
        .upsert({ id: 'singleton', category_priority: localCat, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      if (migErr) console.error('[loadInitialData] category_priority migration error:', migErr);
      else console.log('[loadInitialData] migrated localStorage category_priority to system_state');
    }

    if (dbSvcPriority && typeof dbSvcPriority === 'object') {
      initialSvcPriority = dbSvcPriority;
      try { localStorage.setItem(SVC_PRIORITY_KEY, JSON.stringify(dbSvcPriority)); } catch {}
    } else if (localSvc && Object.keys(localSvc).length > 0) {
      initialSvcPriority = localSvc;
      const { error: migErr } = await supabase
        .from('system_state')
        .upsert({ id: 'singleton', service_priority: localSvc, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      if (migErr) console.error('[loadInitialData] service_priority migration error:', migErr);
      else console.log('[loadInitialData] migrated localStorage service_priority to system_state');
    }

    dispatch({ type: 'LOAD_STATE', state: {
      manicurists, queue, completed, appointments, salonServices,
      turnCriteria, calendarDays, dailyHistory: cleanedHistory,
      staffSchedules, staffScheduleOverrides, staffTimeOff,
      categoryPriority: initialCatPriority,
      servicePriority: initialSvcPriority,
    } });

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
    // In-progress entries (completedAt = null) fall back to startedAt for
    // staleness checks. If even startedAt is missing, treat as today (don't
    // archive — let the trigger or manicurist DONE press fill it in).
    const staleCompleted = completed.filter(c => {
      const ts = c.completedAt ?? c.startedAt;
      return ts ? getLocalDateStr(new Date(ts)) < today : false;
    });
    const staleQueue = queue.filter(c => getLocalDateStr(new Date(c.arrivedAt)) < today);

    if (staleCompleted.length > 0 || staleQueue.length > 0) {
      console.log('[startup] stale data detected from previous day â archiving and resetting', { staleCompleted: staleCompleted.length, staleQueue: staleQueue.length });

      // SAFETY: read every stale completed_services row directly from the DB
      // and merge with the JS-state entries by id. Without this, anything in
      // the DB that hadn't yet been pulled into JS state (realtime sync lag,
      // a concurrent write from another tab) would be deleted in the cleanup
      // step below without being archived. Root cause of the 5/17 partial
      // archive incident: the JS state held only 18 entries, but the DB had
      // ~108. The 90 in the gap were wiped by the delete with no archive.
      const dbCompletedById = new Map<string, CompletedEntry>();
      for (const c of staleCompleted) {
        dbCompletedById.set(c.id, c);
      }
      try {
        const todayMidnightLA = new Date(today + 'T00:00:00-07:00').toISOString();
        const { data: dbRows, error: fetchErr } = await supabase
          .from('completed_services')
          .select('*')
          .lt('completed_at', todayMidnightLA);
        if (fetchErr) {
          console.error('[startup] failed to fetch stale completed_services from DB:', fetchErr);
        } else if (dbRows) {
          for (const row of dbRows as Array<Record<string, unknown>>) {
            const id = String(row.id ?? '');
            if (id && !dbCompletedById.has(id)) {
              dbCompletedById.set(id, mapDbCompleted(row));
            }
          }
        }
      } catch (err) {
        console.error('[startup] fetch stale completed_services threw:', err);
      }

      // Archive stale completed entries grouped by date, update in-memory state too.
      // In-progress entries (completedAt = null) shouldn't be archived — they're
      // ongoing work. Skip them; they'll be archived after DONE is pressed and
      // a real completed_at is set.
      const byDate = new Map<string, CompletedEntry[]>();
      for (const c of dbCompletedById.values()) {
        if (c.completedAt == null) continue;
        const d = getLocalDateStr(new Date(c.completedAt));
        if (!byDate.has(d)) byDate.set(d, []);
        byDate.get(d)!.push(c);
      }
      // Track which date archives committed successfully so we only delete
      // their rows from completed_services. If a date's upsert errors, leave
      // its rows in place so a future startup retries the archive.
      const archivedDates = new Set<string>();
      const updatedHistory = [...dailyHistory];
      for (const [date, entries] of byDate) {
        const existingIdx = updatedHistory.findIndex(h => h.date === date);
        const existing = existingIdx >= 0 ? updatedHistory[existingIdx] : null;
        // De-dupe by entry id when merging so re-runs of this path can't
        // double-count the same completed_service rows.
        const seenIds = new Set<string>();
        const mergedEntries: CompletedEntry[] = [];
        for (const e of [...(existing?.entries ?? []), ...entries]) {
          if (seenIds.has(e.id)) continue;
          seenIds.add(e.id);
          mergedEntries.push(e);
        }
        const historyEntry: DailyHistory = {
          id: existing?.id ?? crypto.randomUUID(),
          date,
          entries: mergedEntries,
        };
        const { error: histErr } = await supabase.from('daily_history').upsert(
          { id: historyEntry.id, date: historyEntry.date, entries: historyEntry.entries },
          { onConflict: 'date' }
        );
        if (histErr) {
          console.error('[startup] daily_history upsert error for', date, ':', histErr);
          setSyncError('Failed to archive history. Data preserved for retry on next startup.');
          continue;
        }
        archivedDates.add(date);
        // Update in-memory history so the history screen can find it immediately
        dispatch({ type: 'SAVE_DAILY_HISTORY', entry: historyEntry });
      }

      // Clear stale queue entries unconditionally - these were unfinished work
      // that the day boundary aged out, not data that needs archiving.
      for (const c of staleQueue) {
        await supabase.from('queue_entries').delete().eq('id', c.id);
      }
      // Only delete completed_services rows for dates whose archive succeeded.
      // Rows for failed-archive dates stay in DB so the next startup retries.
      const idsToDelete: string[] = [];
      for (const [d, entries] of byDate) {
        if (!archivedDates.has(d)) continue;
        for (const e of entries) idsToDelete.push(e.id);
      }
      if (idsToDelete.length > 0) {
        const { error: deleteErr } = await supabase.from('completed_services').delete().in('id', idsToDelete);
        if (deleteErr) console.error('[startup] failed to delete archived completed_services:', deleteErr);
      }

      dispatch({ type: 'DAILY_RESET' });

      // Update system_state ONLY if every date archived successfully. If any
      // failed, leave last_archive_date stale so the next startup retries.
      const allArchived = byDate.size === 0 || Array.from(byDate.keys()).every(d => archivedDates.has(d));
      if (allArchived) {
        const { error: ssErr } = await supabase
          .from('system_state')
          .upsert({ id: 'singleton', last_archive_date: today, updated_at: new Date().toISOString() }, { onConflict: 'id' });
        if (ssErr) console.error('[startup] failed to update system_state:', ssErr);
        else console.log('[startup] system_state updated to', today);
      } else {
        console.warn('[startup] some dates failed to archive - leaving system_state stale for retry');
      }
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
    // Sort entries by manicurist clock-in order so past-day History views
    // (which use first-appearance insertion order) preserve clock-in sequence.
    const clockInOrder = new Map<string, number>();
    for (const m of manicuristsRef.current) {
      if (m.clockInTime !== null) clockInOrder.set(m.id, m.clockInTime);
    }
    const sortedEntries = [...completed].sort((a, b) => {
      const aTime = clockInOrder.get(a.manicuristId) ?? Number.POSITIVE_INFINITY;
      const bTime = clockInOrder.get(b.manicuristId) ?? Number.POSITIVE_INFINITY;
      return aTime - bTime;
    });
    // MERGE rather than overwrite. daily_history is one row per date, and the
    // upsert below replaces that row's `entries` wholesale. If this device's
    // `completed` list is partial (e.g. it loaded after a clear, or mid-sync),
    // a blind overwrite would erase a fuller record another device/the nightly
    // job already saved (a contributor to the 6/5 turn loss). So we read the
    // current stored row, union by entry id, and let THIS device's live copy win
    // on conflict (carries the latest edits/voids) while never dropping ids it
    // simply didn't have. Read the DB (not the in-memory ref) so a save from a
    // different device is merged in too.
    const { data: storedRow } = await supabase
      .from('daily_history')
      .select('id, entries')
      .eq('date', date)
      .maybeSingle();
    const mergedById = new Map<string, CompletedEntry>();
    for (const e of ((storedRow?.entries as CompletedEntry[] | null) ?? [])) {
      if (e && e.id) mergedById.set(e.id, e);
    }
    for (const e of sortedEntries) mergedById.set(e.id, e); // live wins on conflict
    const mergedEntries = Array.from(mergedById.values()).sort((a, b) => {
      const aTime = clockInOrder.get(a.manicuristId) ?? Number.POSITIVE_INFINITY;
      const bTime = clockInOrder.get(b.manicuristId) ?? Number.POSITIVE_INFINITY;
      return aTime - bTime;
    });
    // Reuse the existing row's ID for this date so repeated saves don't generate a
    // new UUID each time (which would fight the onConflict 'date' upsert).
    const existingId = (storedRow?.id as string | undefined) ?? dailyHistoryRef.current.find(h => h.date === date)?.id;
    const entry: DailyHistory = {
      id: existingId ?? crypto.randomUUID(),
      date,
      entries: mergedEntries,
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

  // Setter for the Blueprint priority lists. Dispatches the local update immediately
  // (so the UI doesn't snap-back during the round-trip), mirrors to localStorage so
  // legacy reads in assignHelpers stay correct, and upserts to Supabase. The realtime
  // subscription will broadcast the change to other devices, which dispatch SET_PRIORITY
  // and update their own localStorage from the same channel handler.
  const setPriority = useCallback(async (next: { categoryPriority?: string[]; servicePriority?: Record<string, string[]> }) => {
    // Local state first — keeps the dragged item in its dropped position.
    dispatch({ type: 'SET_PRIORITY', ...next });
    // Mirror to localStorage so getPriorityRank() in priorityStorage sees the new order
    // even before the round-trip completes.
    if (next.categoryPriority !== undefined) {
      try { localStorage.setItem(CAT_PRIORITY_KEY, JSON.stringify(next.categoryPriority)); } catch {}
    }
    if (next.servicePriority !== undefined) {
      try { localStorage.setItem(SVC_PRIORITY_KEY, JSON.stringify(next.servicePriority)); } catch {}
    }
    // Persist to DB. Wrap in trackSave so save status indicators reflect the upsert.
    await trackSave(async () => {
      const row: Record<string, unknown> = { id: 'singleton', updated_at: new Date().toISOString() };
      if (next.categoryPriority !== undefined) row.category_priority = next.categoryPriority;
      if (next.servicePriority !== undefined) row.service_priority = next.servicePriority;
      const { error } = await withRetry(() => supabase.from('system_state').upsert(row, { onConflict: 'id' }));
      if (error) {
        console.error('[setPriority] upsert error:', error);
        setSyncErrorTracked('Sync failed — priority list may not be saved. Check connection.');
      }
    });
  }, [trackSave, setSyncErrorTracked]);

  const isStaffMode = typeof window !== 'undefined' && (
    new URLSearchParams(window.location.search).get('mode') === 'staff' ||
    (window as any).__TURNEM_STAFF_MODE__ === true
  );

  useEffect(() => {
    if (!state.loaded) return;
    // Snapshot-and-clear the remote flag up front so every early-return path clears it too.
    const wasRemote = isApplyingRemoteRef.current;
    isApplyingRemoteRef.current = false;
    const prev = prevStateRef.current;

    // CRITICAL: detect local appointment deletions BEFORE any early-return on wasRemote.
    // Why: when React batches a local DELETE with a concurrent realtime UPSERT echo into one
    // render, wasRemote ends up true and the rest of the sync gets skipped. Without this guard,
    // the local delete is reflected in state but never persisted to DB, never tombstoned, and a
    // subsequent UPSERT/refresh resurrects the row. Deletions are idempotent and don't cause
    // echo loops, so we always run them regardless of wasRemote.
    if (prev.loaded && !isStaffMode && prev.appointments !== state.appointments) {
      const currentApptIds = new Set(state.appointments.map((a) => a.id));
      // Skip propagation for ids that are already tombstoned. Those are remote
      // deletes that have already happened in DB (the realtime channel handler
      // tombstones on REMOTE_APPOINTMENT_DELETE). Issuing a duplicate SQL
      // DELETE is at best a no-op, but combined with the prior reconcileAppts
      // wholesale-replace it was the trapdoor that silently destroyed live
      // appointments while their staff were still mid-service.
      const deletedAppts = prev.appointments.filter(
        (a) =>
          !currentApptIds.has(a.id) &&
          !isTombstoned(a.id) &&
          // Protect real bookings: only delete from DB if the user explicitly
          // deleted it (recorded in the ledger) or it's a *synthetic* walk-in
          // block (id prefixed `walkin:`). A booked appt that merely went
          // missing from state (a sync/realtime batching race) is left alone
          // and self-heals on the next upsert/refresh instead of being
          // permanently destroyed. The `walkin:` prefix guard also protects
          // real appts that now carry isWalkIn=true while parked after an
          // appointment assignment (per Tony, 2026-06-06).
          (pendingApptDeletesRef.current.has(a.id) || (a.isWalkIn === true && a.id.startsWith('walkin:'))),
      );
      // Consume handled intent markers, and drop any whose appt is still present
      // (an explicit delete superseded by a concurrent re-add) so the set can't
      // grow unbounded.
      for (const a of deletedAppts) pendingApptDeletesRef.current.delete(a.id);
      for (const id of Array.from(pendingApptDeletesRef.current)) {
        if (currentApptIds.has(id)) pendingApptDeletesRef.current.delete(id);
      }
      if (deletedAppts.length > 0) {
        for (const a of deletedAppts) tombstone(a.id);
        trackSave(() => chainAppointmentWrite(async () => {
          for (const a of deletedAppts) {
            const { error } = await withRetry(() => supabase.from('appointments').delete().eq('id', a.id));
            if (error) {
              console.error('[sync deleteAppt] error:', error);
              setSyncErrorTracked('Sync failed — data may not be saved. Check connection.');
            }
          }
        }));
      }
    }

    // Staff mode is read-only - never sync back to DB
    if (isStaffMode) {
      prevStateRef.current = state;
      completedRef.current = state.completed;
      dailyHistoryRef.current = state.dailyHistory;
      manicuristsRef.current = state.manicurists;
      return;
    }
    // This state change came from a realtime subscription. Skip the flush so we don't
    // echo the remote change back to the DB (which would re-broadcast and loop).
    // (Deletion sync above runs unconditionally to survive batched local+remote renders.)
    if (wasRemote) {
      prevStateRef.current = state;
      completedRef.current = state.completed;
      dailyHistoryRef.current = state.dailyHistory;
      manicuristsRef.current = state.manicurists;
      return;
    }
    // On the very first render after loadInitialData dispatches LOAD_STATE, prev still holds
    // INITIAL_STATE (all empty arrays). Syncing here would push empty state back to the DB
    // and race with the just-completed fetch. Skip this first run and just advance the ref.
    if (!prev.loaded) {
      prevStateRef.current = state;
      return;
    }
    if (prev.manicurists !== state.manicurists) trackSave(() => syncManicurists(state.manicurists, prev.manicurists, setSyncErrorTracked));
    if (prev.queue !== state.queue) trackSave(() => syncQueue(state.queue, prev.queue, setSyncErrorTracked, state.salonServices, state.manicurists, state.completed));
    if (prev.completed !== state.completed) trackSave(() => syncCompleted(state.completed, prev.completed, setSyncErrorTracked, state.salonServices, pendingCompletedDeletesRef.current, bulkCompletedClearRef));
    if (prev.appointments !== state.appointments) {
      // Deletions already handled above (with tombstoning). syncAppointments here upserts
      // current rows; its internal delete pass is a redundant safety net. We funnel both
      // writes through chainAppointmentWrite so this UPSERT cannot overtake the DELETE that
      // just got queued above (or any earlier write) — eliminating the write-write race
      // that resurrects appointments after a quick edit-then-delete.
      trackSave(() => chainAppointmentWrite(() => syncAppointments(state.appointments, prev.appointments, setSyncErrorTracked)));
    }
    if (prev.salonServices !== state.salonServices) trackSave(() => syncSalonServices(state.salonServices, prev.salonServices, setSyncErrorTracked));
    if (prev.turnCriteria !== state.turnCriteria) trackSave(() => syncTurnCriteria(state.turnCriteria, prev.turnCriteria, setSyncErrorTracked));
    if (prev.calendarDays !== state.calendarDays) trackSave(() => syncCalendarDays(state.calendarDays, prev.calendarDays, setSyncErrorTracked));
    if (prev.dailyHistory !== state.dailyHistory) trackSave(() => syncDailyHistory(state.dailyHistory, prev.dailyHistory, setSyncErrorTracked));
    if (prev.staffSchedules !== state.staffSchedules) trackSave(() => syncStaffSchedules(state.staffSchedules, prev.staffSchedules, setSyncErrorTracked));
    if (prev.staffScheduleOverrides !== state.staffScheduleOverrides) trackSave(() => syncStaffScheduleOverrides(state.staffScheduleOverrides, prev.staffScheduleOverrides, setSyncErrorTracked));
    if (prev.staffTimeOff !== state.staffTimeOff) trackSave(() => syncStaffTimeOff(state.staffTimeOff, prev.staffTimeOff, setSyncErrorTracked));
    prevStateRef.current = state;
    completedRef.current = state.completed;
    dailyHistoryRef.current = state.dailyHistory;
    manicuristsRef.current = state.manicurists;
  }, [state]);

  // Appointment book sync: derive appt.serviceRequests from the live queue
  // so queue-side staff changes (SPLIT_AND_ASSIGN, MultiServiceAssign,
  // ASSIGN_CLIENT, REQUEST_ASSIGN) propagate to the book without each
  // dispatcher needing to remember to update appointments separately.
  //
  // Conservative: only updates a serviceRequest entry whose manicuristIds
  // differ from the queue's assignment for that service. Preserves any
  // existing clientRequest flag. Adds entries for services that have no
  // matching serviceRequest yet (the empty-array walk-in case). Does NOT
  // remove existing entries — manual edits in AppointmentModal stay.
  //
  // Idempotent — only dispatches UPDATE_APPOINTMENT when the derived next
  // value actually differs from the current, so no infinite loop.
  // (audit 2026-05-31 Bug A v3)
  useEffect(() => {
    if (!state.loaded) return;
    // Group in-progress queue entries by their originalAppointment.id.
    const byApptId = new Map<string, typeof state.queue>();
    for (const q of state.queue) {
      const apptId = q.originalAppointment?.id;
      if (!apptId) continue;
      if (!q.assignedManicuristId) continue;
      const list = byApptId.get(apptId) ?? [];
      list.push(q);
      byApptId.set(apptId, list);
    }
    for (const [apptId, entries] of byApptId) {
      const appt = state.appointments.find((a) => a.id === apptId);
      // Build a map of (serviceName -> intended manicuristId) from the queue.
      // If two entries claim the same service (rare; can happen on partial
      // re-assign), the most recently-started one wins.
      const desired = new Map<string, string>();
      const orderedByStart = [...entries].sort((a, b) => {
        const ta = a.startedAt ?? 0;
        const tb = b.startedAt ?? 0;
        return ta - tb;
      });
      for (const e of orderedByStart) {
        if (!e.assignedManicuristId) continue;
        for (const svc of e.services ?? []) {
          desired.set(svc, e.assignedManicuristId);
        }
      }
      if (desired.size === 0) continue;
      const desiredReqs = Array.from(desired.entries()).map(([svc, mid]) => ({
        service: svc as ServiceType,
        manicuristIds: [mid],
        clientRequest: false,
      }));
      const desiredServices = Array.from(desired.keys()) as ServiceType[];
      if (!appt) {
        // Dangling reference: queue entries point at an appt the reducer
        // already deleted (e.g. CANCEL_SERVICE on a walk-in removed the
        // synth block, then the cashier reassigned via MultiServiceAssign;
        // SPLIT_AND_ASSIGN children inherited the parent's now-deleted
        // originalAppointment.id and skipped synth at line 822-823 of the
        // reducer). Re-synthesize from the queue entry's preserved
        // originalAppointment snapshot + the derived service/staff map.
        // (audit 2026-05-31 Bug A v4)
        const first = orderedByStart[0];
        const seed = first.originalAppointment;
        if (!seed) continue;
        const primaryStaff = first.assignedManicuristId;
        dispatch({
          type: 'ADD_APPOINTMENT',
          appointment: {
            ...seed,
            id: apptId,
            services: desiredServices,
            serviceRequests: desiredReqs,
            manicuristId: primaryStaff ?? seed.manicuristId,
            // Re-flag as walk-in so the receptionist can spot the
            // auto-restored block and confirm/move it.
            isWalkIn: true,
          },
        });
        continue;
      }
      const currentReqs = appt.serviceRequests ?? [];
      // TEMP (2026-05-31, urgent): do NOT override an existing serviceRequest's
      // manicuristIds from the live queue. That override was reverting manual
      // drags of in-service blocks in the appointment book (blocks "snapped
      // back" to their original column). The receptionist needs to freely move
      // blocks to see/rearrange them during service. We still ADD missing
      // services and re-synth deleted appts below; we just no longer clobber a
      // block the user moved by hand.
      let changed = false;
      const next: typeof currentReqs = [...currentReqs];
      // Add entries for services the queue has but the appt doesn't yet.
      const covered = new Set(currentReqs.map((r) => r.service));
      for (const [svc, mid] of desired) {
        if (covered.has(svc)) continue;
        next.push({
          service: svc as typeof currentReqs[number]['service'],
          manicuristIds: [mid],
          clientRequest: false,
        });
        changed = true;
      }
      if (!changed) continue;
      dispatch({
        type: 'UPDATE_APPOINTMENT',
        id: apptId,
        updates: { serviceRequests: next },
      });
    }
  }, [state.queue, state.appointments, state.loaded]);

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

    const staffSchedulesChan = supabase
      .channel('realtime:staff_schedules')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'staff_schedules' }, (payload) => {
        isApplyingRemoteRef.current = true;
        if (payload.eventType === 'DELETE') {
          const id = (payload.old as { id?: string } | null)?.id;
          if (id) dispatch({ type: 'REMOTE_STAFF_SCHEDULE_DELETE', id });
          else isApplyingRemoteRef.current = false;
        } else {
          dispatch({ type: 'REMOTE_STAFF_SCHEDULE_UPSERT', entry: mapDbStaffSchedule(payload.new as Record<string, unknown>) });
        }
      })
      .subscribe();

    const staffTimeOffChan = supabase
      .channel('realtime:staff_time_off')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'staff_time_off' }, (payload) => {
        isApplyingRemoteRef.current = true;
        if (payload.eventType === 'DELETE') {
          const id = (payload.old as { id?: string } | null)?.id;
          if (id) dispatch({ type: 'REMOTE_STAFF_TIME_OFF_DELETE', id });
          else isApplyingRemoteRef.current = false;
        } else {
          dispatch({ type: 'REMOTE_STAFF_TIME_OFF_UPSERT', entry: mapDbStaffTimeOff(payload.new as Record<string, unknown>) });
        }
      })
      .subscribe();

    const staffScheduleOverridesChan = supabase
      .channel('realtime:staff_schedule_overrides')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'staff_schedule_overrides' }, (payload) => {
        isApplyingRemoteRef.current = true;
        if (payload.eventType === 'DELETE') {
          const id = (payload.old as { id?: string } | null)?.id;
          if (id) dispatch({ type: 'REMOTE_STAFF_SCHEDULE_OVERRIDE_DELETE', id });
          else isApplyingRemoteRef.current = false;
        } else {
          dispatch({ type: 'REMOTE_STAFF_SCHEDULE_OVERRIDE_UPSERT', entry: mapDbStaffScheduleOverride(payload.new as Record<string, unknown>) });
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
        // Priority columns: dispatch SET_PRIORITY (no need to set isApplyingRemoteRef
        // because SET_PRIORITY updates only state.categoryPriority/servicePriority,
        // neither of which is touched by the local sync effect — there's no echo to skip).
        // Mirror to localStorage so legacy reads in assignHelpers.getDistinctServices
        // (and the priorityStorage helpers) see the same ordering on every device.
        const remoteCat = newRow?.category_priority as string[] | null | undefined;
        const remoteSvc = newRow?.service_priority as Record<string, string[]> | null | undefined;
        const priorityUpdate: { categoryPriority?: string[]; servicePriority?: Record<string, string[]> } = {};
        if (Array.isArray(remoteCat)) {
          priorityUpdate.categoryPriority = remoteCat;
          try { localStorage.setItem(CAT_PRIORITY_KEY, JSON.stringify(remoteCat)); } catch {}
        }
        if (remoteSvc && typeof remoteSvc === 'object' && !Array.isArray(remoteSvc)) {
          priorityUpdate.servicePriority = remoteSvc;
          try { localStorage.setItem(SVC_PRIORITY_KEY, JSON.stringify(remoteSvc)); } catch {}
        }
        if (priorityUpdate.categoryPriority || priorityUpdate.servicePriority) {
          dispatch({ type: 'SET_PRIORITY', ...priorityUpdate });
        }
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
      supabase.removeChannel(staffSchedulesChan);
      supabase.removeChannel(staffTimeOffChan);
      supabase.removeChannel(staffScheduleOverridesChan);
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

  // Memoize the context value so AppProvider re-renders that didn't actually
  // change anything (e.g. parent re-render with same props) don't cascade
  // into all 30+ useApp() consumers. When state/syncError/saveStatus do change,
  // useMemo returns a fresh object and consumers correctly re-render.
  const ctxValue = useMemo(
    () => ({ state, dispatch, saveTodayHistory, archiveTodayIfNeeded, syncError, clearSyncError, saveStatus, setPriority }),
    [state, dispatch, saveTodayHistory, archiveTodayIfNeeded, syncError, clearSyncError, saveStatus, setPriority],
  );

  return (
    <AppDispatchContext.Provider value={dispatch}>
      <AppContext.Provider value={ctxValue}>
        {children}
      </AppContext.Provider>
    </AppDispatchContext.Provider>
  );
}

/** Subscribe only to the dispatch function. Stable across the lifetime of
 *  AppProvider, so consumers using this hook never re-render from state
 *  changes — they only re-render if their own state/props change. */
export function useAppDispatch() {
  const dispatch = useContext(AppDispatchContext);
  if (!dispatch) throw new Error('useAppDispatch must be used within AppProvider');
  return dispatch;
}

/**
 * Decide whether an error from a Supabase call is worth retrying. Transient =
 * yes (network blip, server overload, deadlock). Permanent = no (auth failure,
 * RLS denial, validation error) — retrying just wastes ~6 seconds and three
 * round-trips before giving the user the same failure toast we'd have given on
 * the first try.
 *
 * Heuristic: explicit error code wins; otherwise fall back to HTTP status; if
 * neither is present (e.g., a thrown TypeError from fetch), assume transient
 * to preserve the previous retry-everything behavior on unknown shapes.
 */
function isTransientError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return true;
  const e = error as { code?: string; status?: number };
  if (typeof e.code === 'string' && e.code.length > 0) {
    // Postgres connection-class errors and serialization/deadlock retries.
    if (e.code.startsWith('08')) return true;
    if (e.code === '40001' || e.code === '40P01') return true;
    // PostgREST errors (auth, RLS, not-found, parse) are permanent.
    if (e.code.startsWith('PGRST')) return false;
    // Data exception, integrity violation, syntax/access — all permanent.
    if (e.code.startsWith('22') || e.code.startsWith('23') || e.code.startsWith('42')) return false;
    // Unknown code: be conservative and retry.
    return true;
  }
  if (typeof e.status === 'number') {
    if (e.status >= 500) return true;
    if (e.status === 408 || e.status === 425 || e.status === 429) return true;
    if (e.status >= 400) return false;
  }
  return true;
}

async function withRetry<T>(
  fn: () => PromiseLike<{ data?: T; error: unknown }>,
  retries = 3,
  delayMs = 2000
): Promise<{ data?: T; error: unknown }> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const result = await fn();
    if (!result.error) return result;
    // Permanent errors: don't waste retries — return the failure immediately.
    if (!isTransientError(result.error)) return result;
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
    (a.notificationBody || '') === (b.notificationBody || '') &&
    JSON.stringify(a.skills) === JSON.stringify(b.skills) &&
    JSON.stringify(a.timeAdjustments || {}) === JSON.stringify(b.timeAdjustments || {})
  );
}

function manicuristToRow(m: Manicurist, idx: number) {
  // total_turns IS included in the sync payload. React local state is the
  // source of truth for the manicurist's turn count. Design (2026-05-28):
  //   - Assignment credits the turn to the manicurist card immediately.
  //   - Edits in queue or on the ticket adjust the credit live.
  //   - Checkout (DONE / PROCESS) locks in the final value recorded to
  //     history.
  //
  // The reducer owns all the arithmetic (SPLIT_AND_ASSIGN, CANCEL_SERVICE,
  // TOGGLE_VOID_COMPLETED, apply-delta on edits, etc). Pushing total_turns
  // from React to DB on each sync keeps the persisted value aligned with
  // what the cashier sees, so a refresh or a second device on the same
  // shift shows the correct number including in-flight assignments.
  //
  // History (commit 48b38c1, 2026-05-27): total_turns was OMITTED here and
  // a DB trigger sync_manicurist_total_turns_from_completed recomputed it
  // from completed_services on every change. That made the DB authoritative
  // — but the DB only sees DONE work, so in-flight assignments were
  // invisible, and the realtime echo of the assignment UPDATE brought DB
  // total_turns=0 back into React, wiping the local at-assignment credit.
  // The trigger has been dropped (migration 2026-05-28) to match the
  // restored design.
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
    notification_body: m.notificationBody || null,
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
    (a.parentQueueId ?? a.id) === (b.parentQueueId ?? b.id) &&
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
    JSON.stringify(a.serviceRequests) === JSON.stringify(b.serviceRequests) &&
    JSON.stringify(a.originalAppointment ?? null) === JSON.stringify(b.originalAppointment ?? null)
  );
}

function queueEntryToRow(c: QueueEntry) {
  return {
    id: c.id,
    parent_queue_id: c.parentQueueId ?? c.id,
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
    original_appointment: c.originalAppointment ?? null,
  };
}

/**
 * For each queue entry whose `assignedManicuristId` just changed from
 * null/undefined to a real id, push that staff into the matching open
 * ticket. Conservative: only fills empty ticket fields.
 */
async function maybeBackfillTicketsForAssignedEntries(
  queue: QueueEntry[],
  prevById: Map<string, QueueEntry>,
  manicurists: AppState['manicurists'],
  salonServices: AppState['salonServices'],
) {
  for (const c of queue) {
    const previous = prevById.get(c.id);
    if (!previous) continue; // newly-added entries are handled below
    const before = previous.assignedManicuristId ?? null;
    const after = c.assignedManicuristId ?? null;
    if (after && after !== before) {
      const m = manicurists.find((mm) => mm.id === after);
      if (!m) continue;
      try {
        await backfillTicketStaff(c.id, m.id, m.name, m.color);
      } catch (err) {
        console.warn('[syncQueue] backfillTicketStaff failed for', c.id, err);
      }
    }
  }

  // Self-healing pass for SPLIT_AND_ASSIGN sibling visits: every assigned
  // entry that belongs to a multi-sibling visit (parentQueueId points at a
  // shared parent and another queue entry shares it) is reconciled via
  // syncEntryToTicket. The helper is idempotent — it only writes when the
  // ticket is missing a line for this sibling, which is exactly the case
  // the old inFlightAutoCreates lock-leak left behind (Stacy / Marie).
  // Now any sibling that ever gets missed — by an interrupted sync, a
  // crashed tab, or a future race — gets reconciled on the next tick.
  const siblingCountByVisit = new Map<string, number>();
  for (const c of queue) {
    if (!c.parentQueueId) continue;
    siblingCountByVisit.set(c.parentQueueId, (siblingCountByVisit.get(c.parentQueueId) ?? 0) + 1);
  }
  for (const c of queue) {
    if (!c.assignedManicuristId) continue;
    if (!c.parentQueueId) continue;
    if ((siblingCountByVisit.get(c.parentQueueId) ?? 0) < 2) continue;
    try {
      await syncEntryToTicket(c, manicurists, salonServices);
    } catch (err) {
      console.warn('[syncQueue] sibling reconcile failed for', c.id, err);
    }
  }
}

// In-memory guard: queue entry ids whose ticket auto-create is currently in
// flight (or already completed within this tab session). Prevents the
// fetchTicketByQueueEntry-then-insert race when syncQueue runs twice in
// quick succession — e.g. user adds the client then immediately assigns a
// manicurist, both dispatches mutate state.queue, both syncQueue calls see
// the entry as "new" before either insert lands. Cross-tab races are still
// possible; the partial unique index on tickets.queue_entry_id closes that.
const inFlightAutoCreates = new Set<string>();

async function syncQueue(queue: QueueEntry[], prev: QueueEntry[], onError: (msg: string) => void, salonServices: AppState['salonServices'], manicurists: AppState['manicurists'], completed: AppState['completed']) {
  const prevById = new Map(prev.map((c) => [c.id, c]));
  const currentIds = new Set(queue.map((c) => c.id));
  // Used by the orphan-ticket-line cleanup at the end: an entry that left
  // the queue legitimately moves to `completed`, where COMPLETE_SERVICE
  // gives the new row the same id as the queue entry. So an entry id that
  // appears here is "removed because completed", not orphaned.
  const completedIds = new Set(completed.map((c) => c.id));

  // Deletes: rows in prev that are no longer in current state. Use .in() to batch.
  const removedIds = prev.filter((c) => !currentIds.has(c.id)).map((c) => c.id);
  if (removedIds.length > 0) {
    const { error } = await withRetry(() => supabase.from('queue_entries').delete().in('id', removedIds));
    if (error) { console.error('[syncQueue] delete error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
  }

  // Upserts: only rows that are new or whose tracked fields changed. Batched into
  // one request instead of one round-trip per row.
  const changed: ReturnType<typeof queueEntryToRow>[] = [];
  for (const c of queue) {
    const previous = prevById.get(c.id);
    if (previous && queueEntryUnchanged(previous, c)) continue;
    changed.push(queueEntryToRow(c));
  }
  // Note: we deliberately do NOT early-return when changed.length === 0.
  // The per-entry reconcile loop below is idempotent (it only writes when the
  // queue and the ticket actually diverge) and is the safety net that keeps
  // the open ticket in sync with reassignments + service edits. Skipping it
  // here meant any cross-tab / cross-render race that didn't tick a tracked
  // field on the local queue row left the ticket showing the old staff or
  // old services until the next unrelated edit. Always running the reconcile
  // costs one Supabase round-trip per assigned entry but avoids drift.
  if (changed.length > 0) {
    const { error: upsertErr } = await withRetry(() => supabase.from('queue_entries').upsert(changed, { onConflict: 'id' }));
    if (upsertErr) { console.error('[syncQueue] upsert error:', upsertErr); onError('Sync failed — data may not be saved. Check connection.'); return; }
  }

  // For existing entries whose assignedManicuristId just transitioned from
  // null to a real id, patch the corresponding ticket's staff so checkout
  // shows the right manicurist even before the service is completed.
  await maybeBackfillTicketsForAssignedEntries(queue, prevById, manicurists, salonServices);

  // Auto-create a Register ticket the moment a manicurist gets assigned.
  // Triggered by:
  //   - new queue entries that already arrive with assignedManicuristId set
  //     (e.g. REQUEST_ASSIGN, SPLIT_AND_ASSIGN children, or appointment
  //     promotion that already had a tech penciled in)
  //   - existing queue entries whose assignedManicuristId just transitioned
  //     from null to a real id (the standard "drag client onto staff" path)
  //
  // Multi-service splits all share `parentQueueId`, so all sibling entries
  // resolve to the same ticket. The first sibling to be assigned creates
  // the ticket; later siblings append their services as additional line
  // items with the sibling's manicurist on staff1.
  //
  // Idempotence: in-tab race guard + DB partial unique index on
  // tickets.queue_entry_id keep us at exactly one ticket per visit even
  // under concurrent writes.
  const justAssigned = queue.filter((c) => {
    if (!c.assignedManicuristId) return false;
    const previous = prevById.get(c.id);
    if (!previous) return true; // arrived already assigned
    return !previous.assignedManicuristId; // just got assigned
  });

  for (const entry of justAssigned) {
    // Normalize to the bare visit UUID so deeper SPLIT_AND_ASSIGN
    // siblings (whose parentQueueId carries `-waiting` / `-mani-X` suffixes)
    // all resolve to the same root ticket instead of opening duplicates.
    const visitId = getVisitId(entry.parentQueueId ?? entry.id);
    try {
      // Race guard keyed on the VISIT id, so all siblings of a split share
      // the same lock — no two siblings can create parallel tickets. If a
      // sibling is mid-create, skip this tick entirely; the next syncQueue
      // pass will see the new ticket and take the append path below.
      if (inFlightAutoCreates.has(visitId)) {
        continue;
      }
      const existing = await fetchTicketByQueueEntry(visitId);

      // Build the line items for THIS entry's services with this entry's
      // assigned manicurist (so split children attribute their lines to
      // the correct tech).
      const m = entry.assignedManicuristId
        ? manicurists.find((mm) => mm.id === entry.assignedManicuristId) ?? null
        : null;
      const itemsForEntry = entry.services.map((svcName, idx) => {
        const svc = salonServices.find((s2) => s2.name === svcName);
        const sr = entry.serviceRequests.find((r) => r.service === svcName);
        const lineMid = sr?.manicuristIds?.[0] ?? m?.id ?? null;
        const lineM = lineMid ? manicurists.find((mm) => mm.id === lineMid) ?? null : null;
        return {
          name: svcName,
          serviceId: svc?.id ?? null,
          staff1Id: lineM?.id ?? null,
          staff1Name: lineM?.name ?? '',
          staff1Color: lineM?.color ?? '#9ca3af',
          unitPriceCents: Math.round((svc?.price ?? 0) * 100),
          quantity: 1,
          // Per-line entry tag so each service lands as its own line and
          // re-syncs are silently deduped. When a single queue entry holds
          // multiple services (e.g. SPLIT_AND_ASSIGN grouping 2 Gel Pedis
          // for the same staff) every service must carry a DISTINCT
          // queue_entry_id, otherwise the upsert's ON CONFLICT (ticket_id,
          // queue_entry_id) drops all but the first.
          queueEntryId: entry.services.length > 1 ? `${entry.id}#svc${idx}` : entry.id,
        };
      });

      if (existing) {
        // Sibling already created the ticket. Add this entry's services as
        // additional lines (de-duped by name/serviceId inside the helper).
        await appendItemsToTicket(existing.id, itemsForEntry);
        // Also patch primary manicurist if the existing ticket has none yet.
        if (!existing.primaryManicuristId && m) {
          try {
            await backfillTicketStaff(visitId, m.id, m.name, m.color);
          } catch (err) {
            console.warn('[syncQueue] backfill on append failed for', visitId, err);
          }
        }
        continue;
      }

      inFlightAutoCreates.add(visitId);
      try {
        // Before opening a fresh ticket, check whether this client already has
        // an OPEN ticket today (e.g. a sibling visit started by a different
        // manicurist, or a SPLIT_AND_ASSIGN child whose parent id we lost
        // track of). If so, append our lines to the existing ticket so
        // Sarah's manicure with Sam and her two pedicures land on a single
        // ticket — even when the pedicures are assigned later. Match by
        // client name today (queue rows don't carry a phone), case-insensitive.
        const businessDate = getTodayLA();
        const sameClient = await findOpenTicketForClient(
          entry.clientName,
          '',
          businessDate,
        );
        if (sameClient) {
          await appendItemsToTicket(sameClient.id, itemsForEntry, { allowDuplicates: true });
          // If the existing ticket has no primary staff yet (it was opened
          // before anyone was assigned), give it one now.
          if (!sameClient.primaryManicuristId && m) {
            try {
              await backfillTicketStaff(
                sameClient.queueEntryId ?? visitId,
                m.id,
                m.name,
                m.color,
              );
            } catch (err) {
              console.warn('[syncQueue] backfill on consolidated append failed for', visitId, err);
            }
          }
        } else {
          await createTicketAtCheckin({
            queueEntryId: visitId,
            appointmentId: entry.originalAppointment?.id ?? null,
            clientName: entry.clientName,
            primaryManicuristId: m?.id ?? null,
            primaryManicuristName: m?.name ?? '',
            primaryManicuristColor: m?.color ?? '#9ca3af',
            items: itemsForEntry,
          });
        }
      } finally {
        // Release the lock as soon as the create (or consolidated append)
        // finishes. Without this, siblings of a SPLIT_AND_ASSIGN that come
        // later in the same justAssigned loop (or in a later tick) would
        // hit the `continue` short-circuit and never get their service
        // lines added — the exact bug behind Stacy's 1-of-3 ticket.
        inFlightAutoCreates.delete(visitId);
      }
    } catch (err) {
      console.error('[syncQueue] auto-create ticket failed for', entry.id, err);
    }
  }

  // ── queue-edit → ticket reconciliation ─────────────────────────────────
  //
  // For every entry that's currently assigned to a manicurist AND existed
  // in the previous tick (so a ticket exists or was about to), call
  // syncEntryToTicket. The helper compares the queue's truth to the
  // ticket's truth itself and only writes when they actually diverge, so
  // it's idempotent — calling it broadly costs one Supabase round-trip
  // per assigned entry but never produces a spurious change.
  //
  // We deliberately AVOID gating on a JS-side diff (servicesChanged etc)
  // because the prev reference comparison can mis-detect changes when
  // React batches multiple dispatches into one render, leaving the
  // ticket out of sync with the queue. The helper's own DB-side diff is
  // the source of truth.
  //
  // We include the null→assigned transition here too — the justAssigned
  // path above only APPENDS to the ticket, and its appendItemsToTicket
  // de-dupes by queue_entry_id, so when a cancel-then-reassign leaves
  // stale lines on the ticket tagged with this entry's id, appendItems
  // sees them as already-present and skips, never updating staff. Without
  // this reconcile pass, the register keeps showing the OLD manicurist
  // (and totals/services) after a queue reassignment. The orphan cleanup
  // below covers removed-without-completion.
  //
  // Conservative on the ticket side: only ticket_items rows tagged with
  // this entry's queue_entry_id (or `entry.id#svc<n>` siblings) are
  // touched. Manually-added cashier lines, retail, and gift card sales
  // are left alone.
  for (const entry of queue) {
    if (!entry.assignedManicuristId) continue;            // not assigned → no ticket yet
    const previous = prevById.get(entry.id);
    if (!previous) continue;                              // new entry → justAssigned handled it
    try {
      const did = await syncEntryToTicket(entry, manicurists, salonServices);
      if (did) {
        console.info('[syncQueue] reconciled ticket for', entry.id, {
          services: entry.services,
          staffId: entry.assignedManicuristId,
        });
      }
      // Continuously (idempotently) ensure this visit's ticket carries its
      // appointment id, so checkout darkens the exact block by id. No-op once
      // set; matched on the ticket's queue_entry_id (the visit root).
      if (entry.originalAppointment?.id) {
        await backfillTicketAppointment(getVisitId(entry.id), entry.originalAppointment.id);
      }
    } catch (err) {
      console.error('[syncQueue] syncEntryToTicket failed for', entry.id, err);
    }
  }

  // ── orphan ticket-line cleanup ─────────────────────────────────────────
  //
  // When a queue entry that was previously assigned to a manicurist
  // disappears WITHOUT being completed (e.g. cashier re-ran
  // MultiServiceAssign with different staff, or manually removed the entry
  // before the work started), the line we appended at assignment time is
  // now orphaned — the ticket bills the client for a service the
  // manicurist never performed. Sweep those lines out here.
  //
  // We only act on entries that were assigned in `prev`. The cleanup
  // helper also cross-checks completed_services, so even if a service was
  // performed via a different code path we won't delete its line.
  // Catches entries that disappeared between renders. Two shapes:
  //   1. Was assigned in prev → caught by the existing condition; runs the
  //      staff-keyed helper to recover the most common case.
  //   2. Disappeared while waiting (prev.assignedManicuristId may already
  //      be null — transient state between CANCEL_SERVICE and the next
  //      reassignment dispatch). The qid-keyed helper below still runs for
  //      every removed entry, so cancel-then-immediate-reassign in the
  //      same render cycle still gets cleaned up. (audit 2026-05-31 v3)
  const removedWithoutCompletion = prev.filter(
    (p) =>
      !!p.assignedManicuristId &&
      !currentIds.has(p.id) &&
      !completedIds.has(p.id),
  );
  const removedRegardlessOfStaff = prev.filter(
    (p) => !currentIds.has(p.id) && !completedIds.has(p.id),
  );
  for (const removed of removedWithoutCompletion) {
    const visitId = getVisitId(removed.parentQueueId ?? removed.id);
    const staffId = removed.assignedManicuristId;
    if (!staffId) continue;
    try {
      const n = await removeOrphanTicketLines(visitId, staffId, removed.services);
      if (n > 0) {
        console.info(
          `[syncQueue] removed ${n} orphan ticket line(s) for visit ${visitId} / staff ${staffId}`,
        );
      }
    } catch (err) {
      console.warn('[syncQueue] orphan cleanup failed for', removed.id, err);
    }
    // ALSO sweep by qid: catches rows whose staff1_id was rewritten by an
    // intermediate syncEntryToTicket name-fallback match before this
    // cleanup ran, which the staff-keyed helper above can't see.
    // (audit 2026-05-31 Bug B v2)
    try {
      const n = await removeTicketLinesByEntryPrefix(visitId, removed.id);
      if (n > 0) {
        console.info(
          `[syncQueue] removed ${n} qid-orphan ticket line(s) for visit ${visitId} / entry ${removed.id}`,
        );
      }
    } catch (err) {
      console.warn('[syncQueue] qid-orphan cleanup failed for', removed.id, err);
    }
  }

  // Broader qid sweep — runs even when prev.assignedManicuristId was null
  // (transient waiting state). Idempotent: if the entry was already cleaned
  // by the staff-keyed loop above, this is a no-op. (audit 2026-05-31 v3)
  const alreadyCleanedIds = new Set(removedWithoutCompletion.map((p) => p.id));
  for (const removed of removedRegardlessOfStaff) {
    if (alreadyCleanedIds.has(removed.id)) continue;
    const visitId = getVisitId(removed.parentQueueId ?? removed.id);
    try {
      const n = await removeTicketLinesByEntryPrefix(visitId, removed.id);
      if (n > 0) {
        console.info(
          `[syncQueue] removed ${n} transient-orphan ticket line(s) for visit ${visitId} / entry ${removed.id}`,
        );
      }
    } catch (err) {
      console.warn('[syncQueue] transient-orphan cleanup failed for', removed.id, err);
    }
  }

  // ── cancel-in-place cleanup ───────────────────────────────────────────
  //
  // CANCEL_SERVICE on a non-add-child queue entry sends it back to
  // status='waiting' (it stays in state.queue, just unassigned). That
  // doesn't trip the disappeared-entry check above, so the ticket_items
  // row appended when the entry was assigned to a manicurist is left
  // orphaned. If the cashier later re-assigns the same entry (possibly
  // with a different service / different staff), the orphan resurrects as
  // a phantom line on the ticket. Detect the in-progress → waiting
  // transition here and run the same cleanup. (2026-05-31 audit Bug B.)
  const cancelledInPlace = prev.filter((p) => {
    if (p.status !== 'inProgress' || !p.assignedManicuristId) return false;
    const cur = queue.find((q) => q.id === p.id);
    return !!cur && cur.status === 'waiting';
  });
  for (const cancelled of cancelledInPlace) {
    const visitId = getVisitId(cancelled.parentQueueId ?? cancelled.id);
    const staffId = cancelled.assignedManicuristId;
    if (!staffId) continue;
    try {
      const n = await removeOrphanTicketLines(visitId, staffId, cancelled.services);
      if (n > 0) {
        console.info(
          `[syncQueue] removed ${n} cancelled-service ticket line(s) for visit ${visitId} / staff ${staffId}`,
        );
      }
    } catch (err) {
      console.warn('[syncQueue] cancel cleanup failed for', cancelled.id, err);
    }
    // ALSO sweep by qid (see disappeared-entry path above for rationale).
    // (audit 2026-05-31 Bug B v2)
    try {
      const n = await removeTicketLinesByEntryPrefix(visitId, cancelled.id);
      if (n > 0) {
        console.info(
          `[syncQueue] removed ${n} qid-orphan ticket line(s) for visit ${visitId} / entry ${cancelled.id}`,
        );
      }
    } catch (err) {
      console.warn('[syncQueue] qid-orphan cleanup failed for', cancelled.id, err);
    }
  }

  // ── final dedupe pass ──────────────────────────────────────────────────
  //
  // Brute-force last-line-of-defense: for every single-service assigned
  // queue entry, ensure there's at most ONE ticket line tagged with its id.
  // The earlier passes (sibling reconcile, justAssigned, syncEntryToTicket
  // reconcile, orphan cleanup) cover the normal cases, but cancel-then-
  // reassign flows that race across multiple syncQueue ticks have been
  // observed to leave a duplicate line on the ticket (the original line
  // with the old staff PLUS a fresh line with the new staff and a `#1`
  // suffix from in-batch collision in appendItemsToTicket). This pass
  // collapses those duplicates to a single canonical line that matches the
  // entry's current assigned manicurist.
  for (const entry of queue) {
    if (!entry.assignedManicuristId) continue;
    try {
      const n = await cleanupDuplicateLinesForEntry(entry, manicurists);
      if (n > 0) {
        console.info(`[syncQueue] dedupe removed ${n} duplicate line(s) for entry ${entry.id}`);
      }
    } catch (err) {
      console.warn('[syncQueue] dedupe failed for', entry.id, err);
    }
  }
}

async function syncCompleted(
  completed: AppState['completed'],
  prev: AppState['completed'],
  onError: (msg: string) => void,
  salonServices: AppState['salonServices'],
  explicitDeleteIds: Set<string>,
  bulkClearRef: { current: boolean },
) {
  const prevById = new Map(prev.map((c) => [c.id, c]));
  const currentIds = new Set(completed.map((c) => c.id));

  // Handle deletes: entries in prev but not in current.
  //
  // CRITICAL: do NOT delete a row from the DB just because it vanished from the
  // in-memory list. A sync / realtime race can transiently drop a still-valid
  // completed entry from `state.completed`; an unconditional diff-delete then
  // destroys real turn history for every device (the 6/5 missing-morning-turns
  // incident). We only delete when the removal was user-intended:
  //   • a bulk clear (History "Clear" button → CLEAR_HISTORY, or the post-save
  //     nightly DAILY_RESET) authorizes deleting every removed row this pass;
  //   • otherwise only ids the user explicitly removed (DELETE_COMPLETED, tracked
  //     in explicitDeleteIds) are deleted.
  // Anything else is left in the DB and self-heals into state on the next load.
  const removedIds = prev.filter((c) => !currentIds.has(c.id)).map((c) => c.id);
  if (removedIds.length > 0) {
    const allowBulk = bulkClearRef.current;
    const idsToDelete = allowBulk
      ? removedIds
      : removedIds.filter((id) => explicitDeleteIds.has(id));
    // Consume the intent markers we just honored so the set can't grow unbounded.
    for (const id of removedIds) explicitDeleteIds.delete(id);
    if (allowBulk) bulkClearRef.current = false;
    const skipped = removedIds.length - idsToDelete.length;
    if (skipped > 0) {
      console.warn(`[syncCompleted] skipped ${skipped} unconfirmed completed delete(s) — left in DB to self-heal (not a user/clear delete)`);
    }
    if (idsToDelete.length > 0) {
      // Batch the IN() list. A single .in('id', [...]) with a large id list builds
      // one giant `id=in.(...)` query string; on a busy-day Clear / nightly reset
      // that overflows the gateway URL limit and the WHOLE request fails with a 400
      // (the "Sync failed — data may not be saved" banner, even though it's a delete
      // and nothing is lost). Deleting in chunks of 200 keeps each request URL small.
      // Same fix as the sales-report ticket-id batching (ID_BATCH_SIZE in lib/tickets.ts).
      const DELETE_BATCH_SIZE = 200;
      for (let i = 0; i < idsToDelete.length; i += DELETE_BATCH_SIZE) {
        const slice = idsToDelete.slice(i, i + DELETE_BATCH_SIZE);
        const { error } = await withRetry(() => supabase.from('completed_services').delete().in('id', slice));
        if (error) { console.error('[syncCompleted] delete error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
      }
    }
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
        !!previous.edited === !!c.edited &&
        !!previous.voided === !!c.voided &&
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
      // Null = work still in progress (queue_entries trigger created this row
      // when the manicurist was assigned). Sending new Date(null) would
      // serialize as the epoch and break the in-progress invariant.
      completed_at: c.completedAt === null ? null : new Date(c.completedAt).toISOString(),
      requested_services: c.requestedServices ?? [],
      is_appointment: !!c.isAppointment,
      is_requested: !!c.isRequested,
      edited: !!c.edited,
      voided: !!c.voided,
    }, { onConflict: 'id' }));
    if (error) { console.error('[syncCompleted] upsert error:', error); onError('Sync failed — data may not be saved. Check connection.'); }

    // Backfill the ticket's staff fields when this is the first time we've
    // seen this completed entry (i.e. previous is undefined). The ticket was
    // auto-created at queue-add time before a manicurist was assigned, so its
    // staff fields are empty. The completed entry's id IS the original queue
    // entry's id (set deterministically in COMPLETE_SERVICE), so we use it to
    // find the matching open ticket.
    //
    // SAFETY NET: if no ticket exists for this queue entry yet (e.g. the
    // service was completed without ever going through the standard
    // "assign in queue" auto-create path), create one now so the register
    // always reflects what was actually performed. Idempotent: we re-check
    // existence inside the in-flight guard so siblings of a split-visit
    // don't each create their own ticket.
    if (!previous && c.manicuristId) {
      // The visit id is what tickets are keyed on. For non-split entries it
      // equals c.id; for SPLIT_AND_ASSIGN children (`${parent}-mani-N` or
      // `${parent}-waiting`) it strips the suffix down to the parent UUID.
      // Using c.id here was the bug that let split-visit children miss the
      // existing ticket and fall into the "append with allowDuplicates"
      // path on every re-mount.
      const visitId = getVisitId(c.id);
      try {
        await backfillTicketStaff(visitId, c.manicuristId, c.manicuristName, c.manicuristColor);
      } catch (err) {
        console.warn('[syncCompleted] backfillTicketStaff failed for', c.id, err);
      }

      // Build this completed entry's items every time — appendItemsToTicket
      // dedupes by queue_entry_id so a re-fire of the same entry is silent.
      try {
        const existing = await fetchTicketByQueueEntry(visitId);
        const items = (c.services && c.services.length > 0 ? c.services : [''])
          .filter((name) => name.trim().length > 0)
          .map((svcName) => {
            const svc = salonServices.find((s) => s.name === svcName);
            return {
              name: svcName,
              serviceId: svc?.id ?? null,
              staff1Id: c.manicuristId,
              staff1Name: c.manicuristName,
              staff1Color: c.manicuristColor,
              unitPriceCents: Math.round((svc?.price ?? 0) * 100),
              quantity: 1,
              queueEntryId: c.id,
            };
          });
        if (items.length > 0) {
          if (existing) {
            // Ticket already exists for this visit. Append this completed
            // entry's services. The lock only gates CREATION; appending an
            // already-created ticket has to happen for every sibling so a
            // 4-service split visit gets all 4 lines (not just sibling #1).
            await appendItemsToTicket(existing.id, items, { allowDuplicates: true });
          } else if (!inFlightAutoCreates.has(visitId)) {
            inFlightAutoCreates.add(visitId);
            try {
              // No ticket yet. Either consolidate onto the same client's
              // open ticket or create a new one. For in-progress rows
              // (completedAt = null), fall back to startedAt so the business
              // date still resolves to today.
              const businessDate = getLocalDateStr(new Date(c.completedAt ?? c.startedAt ?? Date.now()));
              const sameClient = await findOpenTicketForClient(c.clientName, '', businessDate);
              if (sameClient) {
                await appendItemsToTicket(sameClient.id, items, { allowDuplicates: true });
                if (!sameClient.primaryManicuristId) {
                  await backfillTicketStaff(
                    sameClient.queueEntryId ?? visitId,
                    c.manicuristId,
                    c.manicuristName,
                    c.manicuristColor,
                  );
                }
              } else {
                await createTicketAtCheckin({
                  queueEntryId: visitId,
                  appointmentId: null,
                  clientName: c.clientName,
                  primaryManicuristId: c.manicuristId,
                  primaryManicuristName: c.manicuristName,
                  primaryManicuristColor: c.manicuristColor,
                  items,
                });
              }
            } finally {
              inFlightAutoCreates.delete(visitId);
            }
          }
        }
      } catch (err) {
        console.warn('[syncCompleted] fallback ticket create failed for', c.id, err);
      }
    }
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
    if (error) { console.error('[syncDailyHistory] upsert error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
  }
}

function appointmentUnchanged(a: Appointment, b: Appointment): boolean {
  if (a === b) return true;
  return (
    a.clientName === b.clientName &&
    (a.clientPhone || null) === (b.clientPhone || null) &&
    (a.services?.[0] || a.service) === (b.services?.[0] || b.service) &&
    JSON.stringify(a.services || [a.service]) === JSON.stringify(b.services || [b.service]) &&
    JSON.stringify(a.serviceRequests || []) === JSON.stringify(b.serviceRequests || []) &&
    (a.manicuristId || null) === (b.manicuristId || null) &&
    a.date === b.date &&
    a.time === b.time &&
    (a.notes || null) === (b.notes || null) &&
    a.status === b.status &&
    (a.sameTime || false) === (b.sameTime || false) &&
    (a.partyId || null) === (b.partyId || null) &&
    (a.caution || false) === (b.caution || false) &&
    (a.isWalkIn || false) === (b.isWalkIn || false)
  );
}

function appointmentToRow(a: Appointment) {
  return {
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
    same_time: a.sameTime || false,
    party_id: a.partyId || null,
    caution: a.caution || false,
    is_walk_in: a.isWalkIn || false,
    booked_by_receptionist_id: a.bookedByReceptionistId || null,
    last_edited_by_receptionist_id: a.lastEditedByReceptionistId || null,
    last_edited_at: a.lastEditedAt ? new Date(a.lastEditedAt).toISOString() : null,
    created_at: a.createdAt ? new Date(a.createdAt).toISOString() : new Date().toISOString(),
  };
}

async function syncAppointments(appointments: Appointment[], prev: Appointment[], onError: (msg: string) => void) {
  // NOTE: this function NO LONGER deletes. Deletions are handled exclusively by
  // the gated delete-detection in the sync effect (which only removes a real
  // booking when it was explicitly deleted, never on a transient state-diff
  // race). The old unconditional `prev - current` delete pass here was a second,
  // UNGATED path that could destroy a booking that merely went missing for a
  // render — removing it closes that hole. syncAppointments now only upserts.

  // Per-row diff: only upsert appts whose data actually changed. Stops stale tabs from
  // re-uploading every appt (which would resurrect rows another tab just deleted) and
  // cuts realtime echo traffic.
  const prevById = new Map(prev.map((a) => [a.id, a]));
  const changed: ReturnType<typeof appointmentToRow>[] = [];
  for (const a of appointments) {
    const previous = prevById.get(a.id);
    if (previous && appointmentUnchanged(previous, a)) continue;
    changed.push(appointmentToRow(a));
  }
  if (changed.length === 0) return;
  const { error } = await withRetry(() => supabase.from('appointments').upsert(changed, { onConflict: 'id' }));
  if (error) { console.error('[syncAppointments] upsert error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
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
  const { error } = await withRetry(() => supabase.from('turn_criteria').upsert(changed, { onConflict: 'id' }));
  if (error) { console.error('[syncTurnCriteria] upsert error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
}

function calendarDayUnchanged(a: CalendarDay, b: CalendarDay): boolean {
  if (a === b) return true;
  return a.status === b.status && a.note === b.note;
}

function calendarDayToRow(d: CalendarDay) {
  return { date: d.date, status: d.status, note: d.note };
}

async function syncCalendarDays(calendarDays: CalendarDay[], prev: CalendarDay[], onError: (msg: string) => void) {
  const currentDates = new Set(calendarDays.map((d) => d.date));
  const removed = prev.filter((d) => !currentDates.has(d.date));
  if (removed.length > 0) {
    const { error } = await withRetry(() => supabase.from('calendar_days').delete().in('date', removed.map((d) => d.date)));
    if (error) { console.error('[syncCalendarDays] delete error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
  }
  const prevByDate = new Map(prev.map((d) => [d.date, d]));
  const changed: ReturnType<typeof calendarDayToRow>[] = [];
  for (const d of calendarDays) {
    const previous = prevByDate.get(d.date);
    if (previous && calendarDayUnchanged(previous, d)) continue;
    changed.push(calendarDayToRow(d));
  }
  if (changed.length === 0) return;
  const { error } = await withRetry(() => supabase.from('calendar_days').upsert(changed, { onConflict: 'date' }));
  if (error) { console.error('[syncCalendarDays] upsert error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
}


// ─── Staff schedules / time off sync helpers ─────────────────────────────────

function staffScheduleToRow(s: StaffScheduleEntry) {
  return {
    id: s.id,
    manicurist_id: s.manicuristId,
    weekday: s.weekday,
    start_time: s.startTime,
    end_time: s.endTime,
    lunch_start: s.lunchStart,
    lunch_end: s.lunchEnd,
  };
}

function staffScheduleUnchanged(a: StaffScheduleEntry, b: StaffScheduleEntry): boolean {
  if (a === b) return true;
  return (
    a.manicuristId === b.manicuristId &&
    a.weekday === b.weekday &&
    a.startTime === b.startTime &&
    a.endTime === b.endTime &&
    a.lunchStart === b.lunchStart &&
    a.lunchEnd === b.lunchEnd
  );
}

async function syncStaffSchedules(current: StaffScheduleEntry[], prev: StaffScheduleEntry[], onError: (msg: string) => void) {
  const currentIds = new Set(current.map((s) => s.id));
  const removed = prev.filter((s) => !currentIds.has(s.id));
  if (removed.length > 0) {
    const { error } = await withRetry(() => supabase.from('staff_schedules').delete().in('id', removed.map((s) => s.id)));
    if (error) { console.error('[syncStaffSchedules] delete error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
  }
  const prevById = new Map(prev.map((s) => [s.id, s]));
  const changed: ReturnType<typeof staffScheduleToRow>[] = [];
  for (const s of current) {
    const previous = prevById.get(s.id);
    if (previous && staffScheduleUnchanged(previous, s)) continue;
    changed.push(staffScheduleToRow(s));
  }
  if (changed.length === 0) return;
  const { error } = await withRetry(() => supabase.from('staff_schedules').upsert(changed, { onConflict: 'id' }));
  if (error) { console.error('[syncStaffSchedules] upsert error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
}

function staffTimeOffToRow(t: StaffTimeOff) {
  return {
    id: t.id,
    manicurist_id: t.manicuristId,
    start_date: t.startDate,
    end_date: t.endDate,
    reason: t.reason,
  };
}

function staffTimeOffUnchanged(a: StaffTimeOff, b: StaffTimeOff): boolean {
  if (a === b) return true;
  return (
    a.manicuristId === b.manicuristId &&
    a.startDate === b.startDate &&
    a.endDate === b.endDate &&
    a.reason === b.reason
  );
}

async function syncStaffTimeOff(current: StaffTimeOff[], prev: StaffTimeOff[], onError: (msg: string) => void) {
  const currentIds = new Set(current.map((t) => t.id));
  const removed = prev.filter((t) => !currentIds.has(t.id));
  if (removed.length > 0) {
    const { error } = await withRetry(() => supabase.from('staff_time_off').delete().in('id', removed.map((t) => t.id)));
    if (error) { console.error('[syncStaffTimeOff] delete error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
  }
  const prevById = new Map(prev.map((t) => [t.id, t]));
  const changed: ReturnType<typeof staffTimeOffToRow>[] = [];
  for (const t of current) {
    const previous = prevById.get(t.id);
    if (previous && staffTimeOffUnchanged(previous, t)) continue;
    changed.push(staffTimeOffToRow(t));
  }
  if (changed.length === 0) return;
  const { error } = await withRetry(() => supabase.from('staff_time_off').upsert(changed, { onConflict: 'id' }));
  if (error) { console.error('[syncStaffTimeOff] upsert error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
}

// ─── Staff schedule overrides sync ────────────────────────────────────────
// Per-date overrides; mirrors syncStaffSchedules in structure (diff against
// prev to compute removed + changed, upsert by id). Realtime echoes are
// suppressed by isApplyingRemoteRef in the parent effect.

function staffScheduleOverrideToRow(o: StaffScheduleOverride) {
  return {
    id: o.id,
    manicurist_id: o.manicuristId,
    date: o.date,
    is_working: o.working,
    start_time: o.startTime,
    end_time: o.endTime,
    lunch_start: o.lunchStart,
    lunch_end: o.lunchEnd,
    updated_at: new Date().toISOString(),
  };
}

function staffScheduleOverrideUnchanged(a: StaffScheduleOverride, b: StaffScheduleOverride): boolean {
  if (a === b) return true;
  return (
    a.manicuristId === b.manicuristId &&
    a.date === b.date &&
    a.working === b.working &&
    a.startTime === b.startTime &&
    a.endTime === b.endTime &&
    a.lunchStart === b.lunchStart &&
    a.lunchEnd === b.lunchEnd
  );
}

async function syncStaffScheduleOverrides(
  current: StaffScheduleOverride[],
  prev: StaffScheduleOverride[],
  onError: (msg: string) => void,
) {
  const currentIds = new Set(current.map((o) => o.id));
  const removed = prev.filter((o) => !currentIds.has(o.id));
  if (removed.length > 0) {
    const { error } = await withRetry(() => supabase.from('staff_schedule_overrides').delete().in('id', removed.map((o) => o.id)));
    if (error) { console.error('[syncStaffScheduleOverrides] delete error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
  }
  const prevById = new Map(prev.map((o) => [o.id, o]));
  const changed: ReturnType<typeof staffScheduleOverrideToRow>[] = [];
  for (const o of current) {
    const previous = prevById.get(o.id);
    if (previous && staffScheduleOverrideUnchanged(previous, o)) continue;
    changed.push(staffScheduleOverrideToRow(o));
  }
  if (changed.length === 0) return;
  const { error } = await withRetry(() => supabase.from('staff_schedule_overrides').upsert(changed, { onConflict: 'id' }));
  if (error) { console.error('[syncStaffScheduleOverrides] upsert error:', error); onError('Sync failed — data may not be saved. Check connection.'); }
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
