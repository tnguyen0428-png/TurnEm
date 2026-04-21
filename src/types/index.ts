export type ServiceType = string;

export type ManicuristStatus = 'available' | 'busy' | 'break';
export type ClientStatus = 'waiting' | 'inProgress' | 'complete';
export type ViewType = 'queue' | 'staff' | 'history' | 'appointments' | 'services' | 'criteria' | 'calendar';
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
}

export interface ServiceRequest {
  service: ServiceType;
  manicuristIds: string[];
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
}

export interface Appointment {
  id: string;
  clientName: string;
  clientPhone: string;
  service: ServiceType;
  manicuristId: string | null;
  date: string;
  time: string;
  notes: string;
  status: 'scheduled' | 'checked-in' | 'completed' | 'cancelled' | 'no-show';
  createdAt: number;
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
  loaded: boolean;
}
