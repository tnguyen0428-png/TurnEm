import type { AppState, ViewType, ModalType, Manicurist, QueueEntry, Appointment, SalonService, TurnCriteria, CalendarDay, DailyHistory, AppointmentDraft, CompletedEntry, StaffScheduleEntry, StaffScheduleOverride, StaffTimeOff } from '../types';

export type AppAction =
  | { type: 'SET_VIEW'; view: ViewType }
  | { type: 'SET_MODAL'; modal: ModalType }
  | { type: 'LOAD_STATE'; state: Partial<AppState> }
  | { type: 'ADD_MANICURIST'; manicurist: Manicurist }
  | { type: 'UPDATE_MANICURIST'; id: string; updates: Partial<Manicurist> }
  | { type: 'DELETE_MANICURIST'; id: string }
  | { type: 'CLOCK_IN'; id: string }
  | { type: 'CLOCK_OUT'; id: string }
  | { type: 'SET_BREAK'; id: string }
  | { type: 'END_BREAK'; id: string }
  | { type: 'ADD_CLIENT'; client: QueueEntry }
  // `allowDroppingBackedServices` has the same meaning as on
  // UPDATE_APPOINTMENT below: this action mirrors the entry's services onto
  // the linked appointment, and that mirror runs retainBackedServices. A
  // RENAME must set it, or the guard sees the old name still backed by a
  // completed row and keeps it alongside the new one — the exact phantom the
  // Debbie Ma fix removed. Set it only where the rename is deliberate.
  | { type: 'UPDATE_CLIENT'; id: string; updates: Partial<QueueEntry>; allowDroppingBackedServices?: boolean }
  | { type: 'SET_EDITING_CLIENT'; clientId: string | null }
  | { type: 'REMOVE_CLIENT'; id: string }
  | { type: 'ASSIGN_CLIENT'; clientId: string; manicuristId: string }
  | { type: 'COMPLETE_SERVICE'; manicuristId: string; queueEntryId?: string }
  // `discard` = this card should not exist at all: delete the queue entry
  // instead of returning it to the waiting list. Only meaningful for split
  // children (see the reducer) — a backed-out split otherwise has no exit but
  // DONE, which mints a phantom earnings entry.
  | { type: 'CANCEL_SERVICE'; manicuristId: string; discard?: boolean }
  | { type: 'SET_SELECTED_CLIENT'; clientId: string | null }
  | { type: 'SET_EDITING_STAFF'; staffId: string | null }
  | { type: 'CLEAR_HISTORY' }
  | { type: 'UPDATE_COMPLETED'; id: string; updates: Partial<CompletedEntry>; skipEditFlag?: boolean }
  | { type: 'DELETE_COMPLETED'; id: string }
  // `receptionistId` / `reason` come from the PIN gate that already fronts this
  // action in EditCompletedModal — it collects them and used to discard them.
  // Optional so a caller without a gate (none today) still compiles; the stamp
  // is simply left blank, and completed_services_void_log records the flip
  // regardless.
  | { type: 'TOGGLE_VOID_COMPLETED'; id: string; receptionistId?: string; reason?: string }
  | { type: 'REQUEST_ASSIGN'; client: QueueEntry; manicuristId: string }
  | { type: 'SPLIT_AND_ASSIGN'; originalId: string; entries: { client: QueueEntry; manicuristId: string | null }[] }
  | { type: 'ADD_APPOINTMENT'; appointment: Appointment }
  // `allowDroppingBackedServices` opts OUT of the reducer's retainBackedServices
  // guard, which otherwise refuses to shrink services[] past a service that has
  // a live queue entry or a completed_services row. Set it ONLY where a human
  // has been shown what the removal costs and explicitly confirmed (the
  // AppointmentModal dialog). Every other caller leaves it unset so a silent or
  // automated write can never drop work that's on the floor.
  | { type: 'UPDATE_APPOINTMENT'; id: string; updates: Partial<Appointment>; allowDroppingBackedServices?: boolean }
  | { type: 'DELETE_APPOINTMENT'; id: string }
  | { type: 'SET_EDITING_APPOINTMENT'; appointmentId: string | null }
  | { type: 'SET_APPOINTMENT_DRAFT'; draft: AppointmentDraft | null }
  | { type: 'SET_PENDING_APPOINTMENT_PREVIEW'; appointments: Appointment[] | null }
  | { type: 'ADD_SALON_SERVICE'; service: SalonService }
  | { type: 'UPDATE_SALON_SERVICE'; id: string; updates: Partial<SalonService> }
  | { type: 'DELETE_SALON_SERVICE'; id: string }
  | { type: 'SET_EDITING_SERVICE'; serviceId: string | null }
  | { type: 'UPDATE_TURN_CRITERIA'; criteria: TurnCriteria }
  | { type: 'SET_TURN_CRITERIA'; criteria: TurnCriteria[] }
  | { type: 'SET_CALENDAR_DAY'; day: CalendarDay }
  | { type: 'REMOVE_CALENDAR_DAY'; date: string }
  | { type: 'REORDER_MANICURIST'; id: string; direction: 'up' | 'down' }
  | { type: 'SET_MANICURIST_ORDER'; ids: string[] }
  | { type: 'REORDER_SALON_SERVICE'; id: string; direction: 'up' | 'down' }
  | { type: 'SET_SALON_SERVICE_ORDER'; ids: string[] }
  | { type: 'TOGGLE_FOURTH_POSITION_SPECIAL'; id: string }
  | { type: 'TOGGLE_CHECK2'; id: string }
  | { type: 'TOGGLE_CHECK3'; id: string }
  | { type: 'TOGGLE_WAX'; id: string }
  | { type: 'TOGGLE_WAX2'; id: string }
  | { type: 'TOGGLE_WAX3'; id: string }
  | { type: 'SAVE_DAILY_HISTORY'; entry: DailyHistory }
  | { type: 'DAILY_RESET' }
  // --- Remote-sync actions ---
  // Dispatched by the realtime subscription when another device writes to the DB.
  // The AppContext sync effect checks `isApplyingRemoteRef` and skips its DB flush
  // for any state change caused by these actions, preventing echo loops.
  | { type: 'REMOTE_MANICURIST_UPSERT'; manicurist: Manicurist }
  | { type: 'REMOTE_MANICURIST_DELETE'; id: string }
  | { type: 'REMOTE_QUEUE_UPSERT'; entry: QueueEntry }
  | { type: 'REMOTE_QUEUE_DELETE'; id: string }
  | { type: 'REMOTE_COMPLETED_UPSERT'; entry: CompletedEntry }
  | { type: 'REMOTE_COMPLETED_DELETE'; id: string }
  | { type: 'REMOTE_APPOINTMENT_UPSERT'; appointment: Appointment }
  | { type: 'REMOTE_APPOINTMENT_DELETE'; id: string }
  | { type: 'REMOTE_SALON_SERVICE_UPSERT'; service: SalonService }
  | { type: 'REMOTE_SALON_SERVICE_DELETE'; id: string }
  | { type: 'REMOTE_TURN_CRITERIA_UPSERT'; criteria: TurnCriteria }
  | { type: 'REMOTE_TURN_CRITERIA_DELETE'; id: string }
  | { type: 'REMOTE_CALENDAR_DAY_UPSERT'; day: CalendarDay }
  | { type: 'REMOTE_CALENDAR_DAY_DELETE'; date: string }
  | { type: 'REMOTE_SYSTEM_STATE_UPDATE'; lastArchiveDate: string | null }
  // Priority list updates. Local dispatch is wrapped by AppContext.setPriority,
  // which also writes to localStorage and upserts to Supabase. Remote events
  // dispatch the same action without re-writing to Supabase.
  | { type: 'SET_PRIORITY'; categoryPriority?: string[]; servicePriority?: Record<string, string[]> }
  // --- Staff schedules / time off ---
  | { type: 'SET_STAFF_SCHEDULE_DAY'; entry: StaffScheduleEntry }
  | { type: 'CLEAR_STAFF_SCHEDULE_DAY'; manicuristId: string; weekday: number }
  | { type: 'ADD_STAFF_TIME_OFF'; entry: StaffTimeOff }
  | { type: 'UPDATE_STAFF_TIME_OFF'; id: string; updates: Partial<StaffTimeOff> }
  | { type: 'DELETE_STAFF_TIME_OFF'; id: string }
  | { type: 'REMOTE_STAFF_SCHEDULE_UPSERT'; entry: StaffScheduleEntry }
  | { type: 'REMOTE_STAFF_SCHEDULE_DELETE'; id: string }
  | { type: 'REMOTE_STAFF_TIME_OFF_UPSERT'; entry: StaffTimeOff }
  | { type: 'REMOTE_STAFF_TIME_OFF_DELETE'; id: string }
  // Per-date schedule override (one row per (manicuristId, date)). SET upserts,
  // CLEAR removes the override so the date falls back to the recurring blueprint.
  | { type: 'SET_STAFF_SCHEDULE_OVERRIDE'; entry: StaffScheduleOverride }
  | { type: 'CLEAR_STAFF_SCHEDULE_OVERRIDE'; manicuristId: string; date: string }
  | { type: 'REMOTE_STAFF_SCHEDULE_OVERRIDE_UPSERT'; entry: StaffScheduleOverride }
  | { type: 'REMOTE_STAFF_SCHEDULE_OVERRIDE_DELETE'; id: string };
