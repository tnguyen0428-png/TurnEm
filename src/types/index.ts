export type ServiceType = string;

export type ManicuristStatus = 'available' | 'busy' | 'break';
export type ClientStatus = 'waiting' | 'inProgress' | 'complete';
export type ViewType = 'queue' | 'staff' | 'history' | 'appointments' | 'services' | 'criteria' | 'calendar' | 'blueprint' | 'register';
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
  notificationBody?: string; // custom push notification body (per staff); falls back to default if empty
}

export interface ServiceRequest {
  service: ServiceType;
  manicuristIds: string[];
  clientRequest?: boolean; // true = client explicitly requested; false/undefined = salon placed
  startTime?: string;      // HH:MM — per-service start time (overrides appointment time)
  // Per-appointment, per-service duration tweak in minutes. Stacks on top of
  // the base service duration and the assigned staff time adjustment.
  durationAdjustment?: number;
}

export interface QueueEntry {
  id: string;
  /**
   * The "visit" id — same across all queue entries for a single client visit.
   * For original (non-split) entries this equals `id`. For SPLIT_AND_ASSIGN
   * children this points back to the original client.id. Tickets are keyed by
   * this so a multi-service split client still ends up on ONE ticket.
   */
  parentQueueId?: string;
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
  /** Set to true when this row was modified via the History edit modal. */
  edited?: boolean;
  /** Set to true when the row was voided (kept for visibility, excluded from turn totals). */
  voided?: boolean;
}

// ── POS / Register ───────────────────────────────────────────────────────────
//
// SalonBiz-mirrored register flow.
//
// Lifecycle:
//   open    — created at check-in (queue entry), edits allowed, no payment
//   closed  — Process Ticket completed; payments captured; cannot be edited
//   voided  — manager-only; row preserved for audit
//
// Money everywhere is integer cents. Per-line attribution supports two staff
// (Staff1/Staff2) so split work can be tracked even when one ticket is paid.

export type TicketStatus = 'open' | 'closed' | 'voided';
export type TicketItemKind = 'service' | 'retail' | 'discount' | 'gift_card_sale';
export type PaymentMethod = 'cash' | 'visa_mc' | 'gift';
export type ShiftStatus = 'open' | 'closed';
export type ShiftMovementKind = 'pay_in' | 'pay_out';

export interface TicketItem {
  id: string;
  ticketId: string;
  kind: TicketItemKind;
  name: string;
  serviceId: string | null;
  staff1Id: string | null;
  staff1Name: string;
  staff1Color: string;
  staff2Id: string | null;
  staff2Name: string;
  staff2Color: string;
  unitPriceCents: number;       // can be negative for kind='discount'
  quantity: number;             // >= 1
  discountCents: number;        // per-line discount, positive
  extPriceCents: number;        // unit_price * qty - discount
  sortOrder: number;
}

export interface Payment {
  id: string;
  ticketId: string;
  shiftId: string | null;
  method: PaymentMethod;
  amountCents: number;          // positive for charge, negative for refund
  tenderedCents: number | null; // cash only
  changeCents: number | null;   // cash only
  giftCardCode: string;         // gift only
  processor: 'manual' | 'square' | 'stripe';
  processorPaymentId: string;
  cardBrand: string;
  cardLast4: string;
  refundOf: string | null;
  capturedAt: number;           // ms epoch
}

export interface Ticket {
  id: string;
  ticketNumber: number;         // per-business-date sequential
  businessDate: string;         // YYYY-MM-DD (LA-local)
  queueEntryId: string | null;
  appointmentId: string | null;
  completedServiceId: string | null;
  shiftId: string | null;       // set when closed

  clientName: string;
  clientPhone: string;
  clientEmail: string;

  primaryManicuristId: string | null;
  primaryManicuristName: string;
  primaryManicuristColor: string;

  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
  paidCents: number;

  status: TicketStatus;
  note: string;
  voidReason: string;

  openedAt: number;             // ms epoch
  closedAt: number | null;      // ms epoch
  updatedAt: number;            // ms epoch

  items: TicketItem[];
  payments: Payment[];
}

export interface Shift {
  id: string;
  businessDate: string;         // YYYY-MM-DD
  drawerNumber: number;
  status: ShiftStatus;
  openedAt: number;
  openingCashCents: number;
  closedAt: number | null;
  expectedCashCents: number | null;
  declaredCashCents: number | null;
  varianceCents: number | null;
  varianceNote: string;
  openingCount: Record<string, number>;
  closingCount: Record<string, number>;
}

export interface ShiftMovement {
  id: string;
  shiftId: string;
  kind: ShiftMovementKind;
  amountCents: number;          // always positive; sign comes from kind
  reason: string;
  createdAt: number;
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

// One row per (manicurist, weekday). Absence of a row for a (manicurist,
// weekday) pair means the technician is off that recurring day. Times are
// HH:MM 24-hour strings. Lunch is a single optional window per day.
export interface StaffScheduleEntry {
  id: string;
  manicuristId: string;
  weekday: number;          // 0=Sun .. 6=Sat
  startTime: string;        // HH:MM
  endTime: string;          // HH:MM
  lunchStart: string | null;
  lunchEnd: string | null;
}

// Vacation / PTO range that overrides the recurring weekly schedule for the
// given technician on every date between startDate and endDate inclusive.
export interface StaffTimeOff {
  id: string;
  manicuristId: string;
  startDate: string;        // YYYY-MM-DD
  endDate: string;          // YYYY-MM-DD
  reason: string;
  createdAt: number;
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
  staffSchedules: StaffScheduleEntry[];
  staffTimeOff: StaffTimeOff[];
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
