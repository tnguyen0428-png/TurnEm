import type { AppState, ViewType, ModalType, Manicurist, QueueEntry, Appointment, SalonService, TurnCriteria, CalendarDay, DailyHistory, AppointmentDraft } from '../types';

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
  | { type: 'UPDATE_CLIENT'; id: string; updates: Partial<QueueEntry> }
  | { type: 'SET_EDITING_CLIENT'; clientId: string | null }
  | { type: 'REMOVE_CLIENT'; id: string }
  | { type: 'ASSIGN_CLIENT'; clientId: string; manicuristId: string }
  | { type: 'COMPLETE_SERVICE'; manicuristId: string }
  | { type: 'CANCEL_SERVICE'; manicuristId: string }
  | { type: 'SET_SELECTED_CLIENT'; clientId: string | null }
  | { type: 'SET_EDITING_STAFF'; staffId: string | null }
  | { type: 'CLEAR_HISTORY' }
  | { type: 'REQUEST_ASSIGN'; client: QueueEntry; manicuristId: string }
  | { type: 'SPLIT_AND_ASSIGN'; originalId: string; entries: { client: QueueEntry; manicuristId: string | null }[] }
  | { type: 'ADD_APPOINTMENT'; appointment: Appointment }
  | { type: 'UPDATE_APPOINTMENT'; id: string; updates: Partial<Appointment> }
  | { type: 'DELETE_APPOINTMENT'; id: string }
  | { type: 'SET_EDITING_APPOINTMENT'; appointmentId: string | null }
  | { type: 'SET_APPOINTMENT_DRAFT'; draft: AppointmentDraft | null }
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
  | { type: 'TOGGLE_FOURTH_POSITION_SPECIAL'; id: string }
  | { type: 'TOGGLE_CHECK2'; id: string }
  | { type: 'TOGGLE_CHECK3'; id: string }
  | { type: 'TOGGLE_WAX'; id: string }
  | { type: 'TOGGLE_WAX2'; id: string }
  | { type: 'TOGGLE_WAX3'; id: string }
  | { type: 'SAVE_DAILY_HISTORY'; entry: DailyHistory }
  | { type: 'DAILY_RESET' };
