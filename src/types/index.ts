export type ServiceType = string;

export type ManicuristStatus = 'available' | 'busy' | 'break';
export type ClientStatus = 'waiting' | 'inProgress' | 'complete';
export type ViewType = 'queue' | 'staff' | 'history' | 'appointments' | 'services' | 'criteria' | 'calendar' | 'blueprint';
export type ModalType =
  | 'addClient'
  | 'editClient'
  | 'addStaff'
  | 'editStaff'
  | 'assignConfirm'
  | 'addAppointment'
  | 'editAppointment'
  | null;

export interface Manicurist {
  id: string;
  name: string;
  color: string;
  phone: string;
  skills: string[];
  clockedIn: boolean;
  clockInTime: number | null;
  totalTurns: number;
  currentClient: string | null;
  status: ManicuristStatus;
  hasFourthPositionSpecial: boolean;
  hasCheck2: boolean;
  hasCheck3: boolean;
  hasWax: boolean;
  hasWax2: boolean;
  hasWax3: boolean;
  timeAdjustments: Record<string, number>;
  pinCode: string;
  breakStartTime: number | null;
  smsOptIn: boolean;
  showInBook?: boolean;      // if false, hidden from appointment book columns
  isReceptionist?: boolean;  // if true, shown in security as having booking access
}

export interface ServiceRequest {
  service: ServiceType;
  manicuristIds: string[];
  clientRequest?: boolean; // true = client explicitly requested; false/undefined = salon placed
  startTime?: string;      // HH:MM — per-service start time (overrides appointment time)
}

export interface QueueEntry {
  id: string;
  clientName: string;
  services: ServiceType[];
  turnValue: number;
  serviceRequests: ServiceRequest[];
  requestedManicuristId: string | null;
  isRequested: boolean;
  isAppointment: boolean;
  assignedManicuristId: string | null;
  status: ClientStatus;
  arrivedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  extraTimeMs: number;
  // Snapshot of the original Appointment captured when this queue entry was
  // promoted from the appointment book via the "Q" key. The Revert button uses
  // it to restore the appointment back into its exact original date, time,
  // column, and per-service placements. Undefined for direct walk-ins.
  originalAppointment?: Appointment;
}

export interface CompletedEntry {
  id: string;
  clientName: string;
  services: ServiceType[];
  turnValue: number;
  manicuristId: string;
  manicuristName: string;
  manicuristColor: string;
  startedAt: number;
  completedAt: number;
  requestedServices?: ServiceType[];
  isAppointment?: boolean;
  isRequested?: boolean;
}

export interface Appointment {
  id: string;
  clientName: string;
  clientPhone: string;
  service: ServiceType;        // kept for backward compat
  services: ServiceType[];     // all services
  serviceRequests: ServiceRequest[];  // per-service manicurist requests
  manicuristId: string | null; // kept for backward compat (first requested manicurist)
  date: string;
  time: string;
  notes: string;
  status: 'scheduled' | 'checked-in' | 'completed' | 'cancelled' | 'no-show';
  createdAt: number;
  sameTime: boolean;          // visual flag: client wants same time as another booking
  partyId: string | null;     // group id linking party-group bookings
}

export interface SalonService {
  id: string;
  name: string;
  turnValue: number;
  duration: number;
  price: number;
  isActive: boolean;
  category: string;
  sortOrder: number;
  isFourthPositionSpecial: boolean;
}

export interface TurnCriteria {
  id: string;
  name: string;
  description: string;
  priority: number;
  enabled: boolean;
  type: 'sort' | 'filter' | 'bonus';
  value: number;
}

export interface CalendarDay {
  date: string;
  status: 'open' | 'blocked';
  note: string;
}

export interface DailyHistory {
  id: string;
  date: string;
  entries: CompletedEntry[];
}

export interface AppointmentDraft {
  date?: string;
  time?: string;
  manicuristId?: string | null;
}

export interface AppState {
  manicurists: Manicurist[];
  queue: QueueEntry[];
  completed: CompletedEntry[];
  appointments: Appointment[];
  salonServices: SalonService[];
  turnCriteria: TurnCriteria[];
  calendarDays: CalendarDay[];
  dailyHistory: DailyHistory[];
  view: ViewType;
  modal: ModalType;
  selectedClient: string | null;
  editingClientId: string | null;
  editingStaffId: string | null;
  editingAppointmentId: string | null;
  editingServiceId: string | null;
  appointmentDraft: AppointmentDraft | null;
  // Priority list — persisted to system_state and synced via Realtime so every
  // device sees the same ordering. Mirrored into localStorage by AppContext for
  // legacy reads in assignHelpers.getDistinctServices.
  categoryPriority: string[];
  servicePriority: Record<string, string[]>;
  loaded: boolean;
}
